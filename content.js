(function () {
  const ID = "__universal_dark_mode_style__";

  // If we've already applied our style, do nothing
  if (document.getElementById(ID)) return;

  const style = document.createElement("style");
  style.id = ID;
  style.textContent = `
    html {
      background: #111 !important;
      color: #eee !important;
      /* Invert + hue-rotate for quick darkening */
      filter: invert(1) hue-rotate(180deg) !important;
    }

    img, video, picture, canvas, iframe, svg {
      /* Re-invert media so it doesn't look weird */
      filter: invert(1) hue-rotate(180deg) !important;
    }

    body, input, textarea, select, button {
      background-color: #111 !important;
      color: #eee !important;
    }
  `;
  document.documentElement.appendChild(style);
})();
