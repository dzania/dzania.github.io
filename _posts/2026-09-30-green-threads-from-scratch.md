---
layout: post
title: Green Threads from Scratch
date: 2026-09-30 00:00 +0000
---
After years of melting my brain with repetitive CRUD work, I decided to explore systems programming and develop some understanding of what happens under the hood. So I've started a small project: build a green thread runtime in Rust. It's not supposed to be production-ready. Just a fun project that lets me write a bit of unsafe Rust and understand green threads a bit better.

> **Note:** the code in this post is simplified to keep it readable. The full, working version is [on GitHub](https://github.com/dzania/rsroutine). It's under 1,000 lines of Rust, so it should be easy to read through after this post.
{: .note}

## What are green threads?
The simplest possible definition of a green thread is a thread created and managed by your programming language runtime instead of the OS. The runtime runs many green threads on a few OS threads and switches between them itself, without going through the kernel. 

In more technical terms, we first need to look at what a [thread](https://en.wikipedia.org/wiki/Thread_(computing)) is. A thread is two things: a stack, and the CPU registers, including a stack pointer into that stack. To switch threads, you save one set of registers and load another. The saved set is called a context. For native OS threads, the kernel takes care of this, but the neat part is that you don't really need the kernel, and you can implement it in any programming language that lets you run a few lines of assembly.

## Stack
As we saw, a thread is a stack plus registers, so every green thread needs its own stack. A stack is nothing more than a block of contiguous memory. Every time a function is called, it gets a chunk of that memory, called a stack frame, for its local variables and return address. The stack pointer `sp` marks where the stack currently ends. A call moves `sp` down to make room for a new frame, and returning moves it back up. On ARM64 the stack grows toward lower addresses, so "down" is literal.

In rsroutine, every task gets 32 KiB. That's small compared to the 2 MiB a `std::thread` gets, and it doesn't grow[^grow], so deep recursion will run out of stack.

At first, I wanted to implement the stack as just a vector of bytes, like this:
```rust
struct Stack {
    bytes: Vec<u8>
}
```
As it turns out, this design has one big problem: there's no way to add a guard page. A guard page is an inaccessible memory page placed at the end of the thread's stack. When the stack attempts to grow into the guard page, the process crashes instantly instead of silently overwriting other memory. A `Vec` naturally can't have one, because its memory comes from the allocator, which shares pages with other allocations, and protection can only be set per page. So instead of using a `Vec`, we need to ask the kernel directly for whole pages via `mmap`, store the pointer to the start of the mapping, and mark the guard page manually.[^pages]

```rust
struct Stack {
    base: *mut u8, // start of the mapping, i.e. the guard page
    len: usize,    // guard page + usable stack
}

impl Stack {
    fn new(size: usize) -> Stack {
        let guard = page_size();         // 16 KiB on Apple Silicon
        let len = guard + size;

        // Reserve everything, with no access at all...
        let base = unsafe {
            libc::mmap(null, len, PROT_NONE, MAP_PRIVATE | MAP_ANON, -1, 0)
        };
        // ...then open up everything above the guard page.
        unsafe { libc::mprotect(base + guard, size, PROT_READ | PROT_WRITE) };

        Stack { base, len }
    }

    fn top(&self) -> usize {
        self.base as usize + self.len    // sp starts here and grows down
    }
}
```
Here's what those two calls do to the memory:


{% include stack.html %}

Each of those blue boxes is a stack frame: the chunk of stack one active function call uses for its local variables, saved registers, and return address.

Bugs, bugs, bugs. The code above allocates a stack just fine, but the memory also has to be freed when the green thread finishes, which of course I forgot at first. Rust's `Drop` trait makes this very convenient: the `Stack` unmaps itself when it's dropped, which happens when the runtime drops a finished green thread.

```rust
impl Drop for Stack {
    fn drop(&mut self) {
        unsafe { libc::munmap(self.base, self.len) };
    }
}
```

## Context
So now we have the first part of the thread. The remaining part is figuring out how to store the CPU registers, and which ones we actually need to store, since the CPU has a lot of them. Every platform has its own set of rules, called a calling convention, for how functions pass arguments and which registers they're allowed to overwrite. I'm developing on Apple Silicon, which follows ARM's [AAPCS64](https://github.com/ARM-software/abi-aa/blob/main/aapcs64/aapcs64.rst#general-purpose-registers). The documentation tells us:
- Caller-saved registers `x0–x17`[^x18] can be overwritten by any function call. If the calling code still needs a value in one of them, it has to save it first.
- Callee-saved registers `x19–x29`, and `d8–d15` for floating point, must hold the same values after a call as before it. If a function wants to use one, it saves the old value and restores it before returning. They're also called call-preserved or non-volatile registers.
- Stack pointer register `sp` stores the memory address of the current top of the stack.
- Link register `x30` holds the address to return to when a subroutine call completes.

From the compiler's point of view, switching to another green thread is just a function call. So the caller-saved registers are already gone, and we only have to save the stack pointer, link register, and callee-saved ones.

```rust
#[repr(C)] // keeps the fields in a fixed order, because the asm reads and writes them at fixed offsets
#[derive(Default)]
struct Context {
    sp: usize,  // stack pointer: where the stack currently ends
    x19: usize, // ... through x28: callee-saved
    x29: usize, // frame pointer: the current stack frame
    x30: usize, // link register: where to continue
    d8: u64,    // ... through d15: callee-saved floating point
}
```

After creating the context struct, it's time to get our hands dirty with a bit of asm. The switch is written in a separate `.S` file that `global_asm!` compiles into the crate. From Rust's side, it's just a foreign function, so we declare it in an `extern "C"` block, the same way you'd declare a C function:

```rust
unsafe extern "C" {
    fn swap_context(from: *mut Context, to: *const Context); // Register switch
    fn bootstrap_entry() -> !; // entry point for a brand-new task
}
```

`extern "C"` means these functions use the C calling convention, which on Apple Silicon is the AAPCS64 we just looked at. So `from` arrives in `x0` and `to` in `x1`. The block is unsafe because Rust can't check that the assembly actually matches these signatures, so we have to promise it does.

The assembly part ended up being much easier than I'd imagined. We only need six instruction types:
- `mov`: copies one register into another
- `str` / `ldr`: store one register to memory / load one register from memory
- `stp` / `ldp`: same as above, but two registers at once
- `br`: jumps to the address in a register

And `[x0, #8]` means the address in `x0`, plus 8 bytes.

```armasm
_swap_context:
    // Save the current registers into `from`.
    mov x2, sp
    str x2, [x0, #0]          // sp
    stp x19, x20, [x0, #8]
    stp x21, x22, [x0, #24]
    stp x23, x24, [x0, #40]
    stp x25, x26, [x0, #56]
    stp x27, x28, [x0, #72]
    stp x29, x30, [x0, #88]   // frame pointer and link register
    stp d8, d9, [x0, #104]
    stp d10, d11, [x0, #120]
    stp d12, d13, [x0, #136]
    stp d14, d15, [x0, #152]

    // Load the registers saved in `to`.
    ldr x2, [x1, #0]
    mov sp, x2                // from here on, we're on the other stack
    ldp x19, x20, [x1, #8]
    ldp x21, x22, [x1, #24]
    ldp x23, x24, [x1, #40]
    ldp x25, x26, [x1, #56]
    ldp x27, x28, [x1, #72]
    ldp x29, x30, [x1, #88]
    ldp d8, d9, [x1, #104]
    ldp d10, d11, [x1, #120]
    ldp d12, d13, [x1, #136]
    ldp d14, d15, [x1, #152]

    br x30                    // continue wherever `to` left off
```
The offsets in brackets are the struct fields in order: `sp` at 0, `x19` at 8, and so on, which is why `Context` needs `#[repr(C)]`. The interesting line is the last one. After the loads, `x30` holds the other task's return address, so `br x30` continues that task right where it once called `swap_context`.

There's one catch: a brand-new task has never called `swap_context`, so it has no return address to jump back to. We fake one. A new task's context gets `x30` pointing at a tiny trampoline:

```armasm
_bootstrap_entry:
    mov x0, x19               // first argument: the task
    br x21                    // jump to task_entry(task)
```

`swap_context` only loads callee-saved registers, so we can't put the task pointer straight into `x0`, the first argument register. Instead it travels in `x19`, and `bootstrap_entry` moves it into place before jumping to the function stored in `x21`. We'll meet that function, `task_entry`, in a moment.

With all the pieces in place, we can finally perform our green thread switching by putting it all together into a tiny runtime: two tasks, each running a closure, and a `main` that takes turns switching between them. It reuses the `Stack` and `Context` from above.

```rust
use std::arch::global_asm;

global_asm!(/* the swap_context and bootstrap_entry assembly from above */);

static mut MAIN: Context = unsafe { std::mem::zeroed() }; // the scheduler's context
static mut CURRENT: *mut Task = std::ptr::null_mut();     // the task running right now

struct Task {
    stack: Stack,
    context: Context,
    func: Option<Box<dyn FnOnce()>>,
    done: bool,
}

fn spawn(func: impl FnOnce() + 'static) -> Box<Task> {
    let stack = Stack::new(32 * 1024);
    let mut task = Box::new(Task { stack, context: Context::default(), func: Some(Box::new(func)), done: false });
    task.context.sp = task.stack.top();
    task.context.x30 = bootstrap_entry as usize; // the first switch "returns" here
    task.context.x19 = &raw mut *task as usize;  // bootstrap_entry moves this into x0
    task.context.x21 = task_entry as usize;      // and then jumps here
    task
}

extern "C" fn task_entry(task: *mut Task) -> ! {
    unsafe {
        ((*task).func.take().unwrap())();
        (*task).done = true;
        swap_context(&raw mut (*task).context, &raw const MAIN); // leave for good
    }
    unreachable!()
}

fn yield_now() {
    unsafe { swap_context(&raw mut (*CURRENT).context, &raw const MAIN) };
}

fn main() {
    let mut tasks = [
        spawn(|| for i in 1..=3 { println!("counter: {i}"); yield_now(); }),
        spawn(|| for w in ["ping", "pong"] { println!("words: {w}"); yield_now(); }),
    ];
    while tasks.iter().any(|t| !t.done) {
        for task in tasks.iter_mut().filter(|t| !t.done) {
            unsafe {
                CURRENT = &raw mut **task;
                swap_context(&raw mut MAIN, &raw const task.context);
            }
        }
    }
    println!("main: all tasks finished");
}
```

We start by creating the `Task` object. It needs to hold any closure, but in Rust every closure has its own type, so we need to store it as `Box<dyn FnOnce()>`, which means *some function we can call once, kept on the heap*. The `Option` is there so we can take the closure out and call it.

Then we need to box the task too, but for a different reason: its context stores a pointer back to the task, so we need to make sure the task stays at the same place in memory.

`spawn` gives each task its own stack and a fake context, so that the first switch into it lands in `task_entry`, which calls the closure.

When a closure calls `yield_now()`, we switch back to `main`, which moves on to the next task. The next time `main` switches back, the closure continues right where it stopped. Its loop counter is still there, because it lives on the task's own stack.

When a closure finishes, the task is marked as done, and `main` stops once every task is done:

```text
counter: 1
words: ping
counter: 2
words: pong
counter: 3
main: all tasks finished
```
The two tasks take turns until `words` runs out, then `counter` finishes on its own.

That's a real green thread runtime, just a very simple one. It runs everything on one OS thread, so the tasks take turns but never actually run at the same time. To get parallelism, we need multiple worker threads.


## Scheduler
Real-world runtimes solve this with an M:N model: M green threads run on N OS threads. Go's goroutines work this way, and so do Erlang processes and Java's virtual threads. My library does the same. It starts one OS thread per CPU core, called a **worker**. Each worker runs a loop just like `main` in the example. With more than one worker, though, we need to decide which worker runs which task.

To make this work properly, we need two kinds of queues. `spawn` puts every new task on a global queue that any worker can take from. Each worker also has its own local queue, and a task that yields goes to the back of its worker's local queue.

Why not keep a single global queue and put yielded tasks at the back of it? Because the values a task creates on its stack don't have to be `Send`: it can hold an `Rc` across `yield_now()` without any compiler error. If another worker resumed it, that `Rc` would suddenly be used from a different thread. So once a task has started, it stays on its worker. The trade-off is that a busy worker can't hand over its started tasks to an idle one.

{% include scheduler.html %}

So what does a worker actually look like? It's the tiny runtime from earlier, just once per OS thread:
```rust
struct Worker {
    id: WorkerId,
    context: Context,                    // the worker's own context: MAIN from the example
    current: Option<Task>,               // the task running right now: CURRENT from the example
    local_queue: LocalQueue<Task>,       // yielded tasks, first in, first out
    parked_tasks: HashMap<TaskId, Task>, // tasks waiting on a join
}

thread_local! {
    // Each OS thread knows its own worker.
    static WORKER: Cell<Option<NonNull<Worker>>> = const { Cell::new(None) };
}

// The part all workers share.
struct Runtime {
    incoming_queue: GlobalQueue<Task>,  // new tasks from spawn(), any worker can take them
    worker_control: Vec<WorkerControl>, // per worker: its OS thread and wake queue, indexed by WorkerId
    idle_workers: Mutex<IdleWorkers>,   // which workers are asleep, so spawn() knows whom to wake
}

// Started on the first spawn().
static RUNTIME: LazyLock<Runtime> = LazyLock::new(|| {
    for i in 0..available_parallelism().get() {
        thread::spawn(move || {
            let mut worker = Box::new(Worker::new(WorkerId(i)));
            WORKER.set(Some(NonNull::from(worker.as_mut())));
            worker.poll(); // the scheduler loop, never returns
        });
    }
    Runtime::new(/* the global queue, and a handle to each worker */)
});

pub fn yield_now() {
    let worker = WORKER.get();           // this thread's worker
    let task = worker.current;           // the task that called yield_now
    task.outcome = Yielded;              // tell dispatch why we're back
    unsafe { swap_context(&mut task.context, &worker.context) };
}
```

`MAIN` from the tiny runtime example became `worker.context`, and `CURRENT` became `worker.current`. They can't be globals anymore, because every OS thread runs its own scheduler loop. So each worker stores a pointer to itself in a thread-local when it starts, and that's how `yield_now()` finds the right worker. This only works because a task always stays on the thread of the worker that started it.

The `Runtime` is the part all workers share: the global queue that `spawn()` pushes to, and a handle to every worker, so `spawn()` can wake a sleeping one. A worker's `id` is its index in `worker_control`, which comes in later, when a finished `join` has to hand a waiting task back to its worker. The runtime itself starts lazily, on the first `spawn()`.

The scheduler loop inside `worker.poll()` looks just like `main` from the example:

```rust
loop {
    let task = worker.wait_for_task(); // from the local or global queue
    worker.dispatch(task);             // run it until it switches back
}
```
`wait_for_task` takes the next task from one of the two queues. If both are empty, the worker puts its OS thread to sleep, and `spawn` wakes it up when there's new work. That's what we call *parking*: when there is no work to be done, we pause the thread so it doesn't waste CPU cycles.

`dispatch` takes care of actually running the task and handling its outcome. In the example, there were only two possible outcomes: the task either yielded or finished. A real-world runtime also needs a third one: the task can be *parked*, waiting for another task's result through `join`.

```rust
fn dispatch(&mut self, task: Task) {
    self.current = Some(task);
    unsafe { swap_context(&mut self.context, &self.current.context) }; // runs until the task switches back
    let task = self.current.take();

    match task.outcome {
        Yielded => self.local_queue.push(task),            // back of the queue
        Parked => self.parked_tasks.insert(task.id, task), // wait until a join wakes it
        Completed => drop(task),                           // frees the stack
    }
}
```
Here's one complete switch from task A through the worker to task B:

{% include context-switch.html %}


## Spawn and join
The last piece is the part a user actually touches. The API may look familiar, as it's inspired by `std::thread`:
```rust
pub fn spawn<F, T>(f: F) -> JoinHandle<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static;

impl<T> JoinHandle<T> {
    pub fn join(self) -> std::thread::Result<T>;
}
```

Most of what `spawn` does we've already seen: it allocates a stack, fakes a context so the first switch lands in the closure, and puts the task on the global queue. If a worker is sleeping, it wakes one up.

The interesting part is the return value. A task only knows how to run a closure that returns nothing, so we wrap your closure in one that returns nothing and stores the result instead:
```rust
move || {
    let result = catch_unwind(AssertUnwindSafe(func));
    packet.complete(result);
}
```

`packet` is a small slot shared between the task and its `JoinHandle`. When the closure finishes, its result goes into the slot, and whoever is waiting on `join` gets woken up. `catch_unwind` turns a panic into an `Err`, just like `std::thread` does, so a panicking task doesn't crash the whole program.[^unwind]

`join` works in two different ways, depending on who calls it. From a normal thread like `main`, it parks the OS thread until the result is ready. From inside a task, it parks only the task: the worker sets it aside and keeps running other tasks, and once the result is ready, the task goes back into its worker's queue and continues inside `join`.

Here's everything together. A task spawns ten children and waits for all of them, without blocking its worker:

```rust
use rsroutine::{spawn, yield_now};

fn main() {
    // A parent task splits the work across child tasks, then joins them.
    let parent = spawn(|| {
        let children: Vec<_> = (0..10)
            .map(|chunk| {
                spawn(move || {
                    let mut sum = 0;
                    for n in chunk * 1_000..(chunk + 1) * 1_000 {
                        sum += n;
                        if n % 100 == 0 {
                            yield_now(); // Let other tasks on this worker run.
                        }
                    }
                    sum
                })
            })
            .collect();

        children
            .into_iter()
            .map(|child| child.join().unwrap())
            .sum::<u64>()
    });

    assert_eq!(parent.join().unwrap(), (0..10_000).sum());

    // A panic inside a task comes back as an Err from join().
    let failed = spawn(|| -> u64 { panic!("boom") });
    assert!(failed.join().is_err());
}
```


## Wrap up

This turned out to be a really fun project. The part that scared me the most, switching between green threads, turned out to be surprisingly simple: a stack, a struct with 21 registers, and a few instructions of assembly. The hard part is everything around it: deciding which task runs where, putting workers to sleep and waking them up when new work comes in.

If you are interested in how a production runtime handles all of that, [Making the Tokio scheduler 10x faster](https://tokio.rs/blog/2019-10-scheduler) is a great next read. Tokio's multi-threaded scheduler starts from a similar layout: a global queue plus a local queue per worker, and then adds the missing pieces.

There's one interesting twist: Tokio can freely move tasks between workers because its tasks are async, and the compiler can check that everything a future holds across an `.await` is `Send`. A stackful green thread has no such check, since the compiler can't see what's on its stack, and that's exactly why rsroutine has to keep started tasks on their worker.


rsroutine is still small and definitely not production-ready: it only runs on Apple Silicon, and stacks have a fixed size. There's no `sleep`, no channels, and no async I/O.

The code is on [GitHub](https://github.com/dzania/rsroutine).


[^grow]: Go takes a different approach: goroutines start with a small stack and get moved to a bigger one when they run out. That's more flexible, but every pointer into the old stack has to be updated.

[^pages]: On most x86 machines a page is 4 KiB. Apple Silicon uses 16 KiB pages, so here the guard page is half the size of the whole 32 KiB stack.

[^x18]: `x18` is missing on purpose: Apple reserves it for the platform, so user code must never touch it.

[^unwind]: It's also required for safety. A task's code is entered from assembly through an `extern "C"` function, and a panic isn't allowed to unwind through that boundary. Rust would abort the whole process instead.
