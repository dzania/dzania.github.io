(() => {
  const searchInput = document.getElementById("search-input");
  const filterButtons = Array.from(document.querySelectorAll(".tag-filter"));
  const posts = Array.from(document.querySelectorAll("[data-archive-post]"));
  const years = Array.from(document.querySelectorAll("[data-archive-year]"));
  const status = document.getElementById("archive-filter-status");
  const emptyState = document.querySelector("[data-archive-empty]");

  if (!searchInput || !filterButtons.length || !status || !emptyState) return;

  let activeTag = "all";

  const applyFilters = () => {
    const query = searchInput.value.trim().toLocaleLowerCase();
    let visibleCount = 0;

    posts.forEach((post) => {
      const tags = post.dataset.tags.split(",").filter(Boolean);
      const matchesTag = activeTag === "all" || tags.includes(activeTag);
      const matchesSearch = !query || post.dataset.title.includes(query) || tags.some((tag) => tag.includes(query));
      const isVisible = matchesTag && matchesSearch;

      post.hidden = !isVisible;
      if (isVisible) visibleCount += 1;
    });

    years.forEach((year) => {
      year.hidden = !year.querySelector("[data-archive-post]:not([hidden])");
    });

    emptyState.hidden = visibleCount !== 0;
    status.textContent = `${visibleCount} ${visibleCount === 1 ? "article" : "articles"} shown`;
  };

  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      activeTag = button.dataset.tag;
      filterButtons.forEach((candidate) => {
        const isActive = candidate === button;
        candidate.classList.toggle("is-active", isActive);
        candidate.setAttribute("aria-pressed", String(isActive));
      });
      applyFilters();
    });
  });

  searchInput.addEventListener("input", applyFilters);
  searchInput.addEventListener("search", applyFilters);
  applyFilters();
})();
