(() => {
  "use strict";

  const cards = Array.from(document.querySelectorAll(".card"));
  const filters = Array.from(document.querySelectorAll("[data-filter]"));
  const status = document.getElementById("filter-status");
  const reset = document.getElementById("reset-filters");
  const revealAll = document.getElementById("reveal-all");
  const hideAll = document.getElementById("hide-all");
  const dialog = document.getElementById("zoom-dialog");
  const dialogImage = document.getElementById("zoom-image");
  const dialogClose = document.getElementById("zoom-close");

  function applyFilters() {
    let visible = 0;
    for (const card of cards) {
      let matches = true;
      for (const filter of filters) {
        const key = filter.getAttribute("data-filter");
        const value = filter.value;
        if (value !== "" && card.getAttribute(`data-${key}`) !== value) {
          matches = false;
          break;
        }
      }
      card.hidden = !matches;
      if (matches) {
        visible += 1;
      }
    }
    if (status) {
      status.textContent = `Showing ${visible} of ${cards.length} cards.`;
    }
  }

  for (const filter of filters) {
    filter.addEventListener("change", applyFilters);
  }

  if (reset) {
    reset.addEventListener("click", () => {
      for (const filter of filters) {
        filter.value = "";
      }
      applyFilters();
    });
  }

  if (revealAll) {
    revealAll.addEventListener("click", () => {
      for (const details of document.querySelectorAll("details.reveal")) {
        details.open = true;
      }
    });
  }

  if (hideAll) {
    hideAll.addEventListener("click", () => {
      for (const details of document.querySelectorAll("details.reveal")) {
        details.open = false;
      }
    });
  }

  function closeDialog() {
    if (!dialog) {
      return;
    }
    if (typeof dialog.close === "function") {
      dialog.close();
    } else {
      dialog.removeAttribute("open");
    }
  }

  function openDialog(image) {
    if (!dialog || !dialogImage) {
      return;
    }
    dialogImage.src = image.currentSrc || image.src;
    dialogImage.alt = image.alt;
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "");
    }
  }

  for (const button of document.querySelectorAll("[data-zoom-target]")) {
    button.addEventListener("click", () => {
      const card = document.getElementById(button.getAttribute("data-zoom-target") || "");
      const image = card ? card.querySelector("img") : null;
      if (image) {
        openDialog(image);
      }
    });
  }

  if (dialogClose) {
    dialogClose.addEventListener("click", closeDialog);
  }

  if (dialog) {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) {
        closeDialog();
      }
    });
  }
})();
