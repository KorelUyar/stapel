// The interface's icons: 16 by 16, drawn as lines. <svg data-i="name"> is filled in at start.
const ICONS = {
  left: "M10 3.5L5.5 8l4.5 4.5",
  right: "M6 3.5L10.5 8 6 12.5",
  folder: "M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z",
  folderPlus: "M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM8 7.4v3.4M6.3 9.1h3.4",
  folderOut: "M1.5 4.5a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM6 9.1h4M8.4 7.5L10 9.1l-1.6 1.6",
  download: "M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10",
  edit: "M10.7 2.7l2.6 2.6-7.4 7.4-3.3.7.7-3.3z",
  sort: "M4.5 3v10M2.5 11l2 2 2-2M9 4h4.5M9 8h3.5M9 12h2",
  reload: "M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3",
  check: "M8 1.8a6.2 6.2 0 1 0 0 12.4A6.2 6.2 0 0 0 8 1.8zM5.3 8.2l1.9 1.9 3.5-4",
  tick: "M3.5 8.5l3 3 6-7",
  sidebar: "M2.5 3.5h11v9h-11zM6.2 3.5v9",
  cursor: "M4.3 2.5v10l2.6-2.4 1.6 3.4 1.6-.8-1.6-3.3h3.5z",
  pen: "M10.6 2.6l2.8 2.8-7.6 7.6-3.4.6.6-3.4zM9.1 4.1l2.8 2.8",
  marker: "M9.6 2.5l3.9 3.9-5.2 5.2H5.4l-.9-.9V7.8zM4.5 10.7l-2 2.8h4.3",
  text: "M3.5 4.4V3h9v1.4M8 3v10M6.2 13h3.6",
  eraser: "M9.4 2.8l3.8 3.8-5.9 5.9H4.6L2.8 10.7zM5.8 6.4l3.8 3.8M8 12.5h5.5",
  undo: "M5.5 3L2.5 6l3 3M2.5 6h6.8a3.7 3.7 0 0 1 0 7.4H6.5",
  redo: "M10.5 3l3 3-3 3M13.5 6H6.7a3.7 3.7 0 0 0 0 7.4h2.8",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.4 10.4l3.1 3.1",
  bookmark: "M4.5 2.5h7v11L8 10.8l-3.5 2.7z",
  spread: "M2.5 3.5h5v9h-5zM8.5 3.5h5v9h-5z",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  plus: "M8 3.5v9M3.5 8h9",
  minus: "M3.5 8h9",
  fit: "M2.5 5.5v-3h3M13.5 5.5v-3h-3M2.5 10.5v3h3M13.5 10.5v3h-3",
  close: "M4 4l8 8M12 4l-8 8",
  trash: "M3 4.5h10M6.5 4.5v-2h3v2M4.5 4.5l.6 9h5.8l.6-9",
  pdf: "M4 2.5h5.5L12 5v8.5H4zM9.5 2.5V5H12",
  book: "M2.5 3.2h4.3c.7 0 1.2.5 1.2 1.200v8.4c0-.6-.5-1-1.200-1H2.5zM13.5 3.2H9.200C8.500 3.2 8 3.700 8 4.400v8.4c0-.6.5-1 1.200-1h4.300z",
};

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.i = name;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name] || "");
  svg.append(path);
  return svg;
}

for (const svg of document.querySelectorAll("svg[data-i]")) {
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[svg.dataset.i] || "");
  svg.append(path);
}
