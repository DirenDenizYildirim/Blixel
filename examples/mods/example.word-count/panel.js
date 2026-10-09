// The view only shows what the logic sends; it keeps no state of its own.

const file = document.getElementById("file");
const words = document.getElementById("words");
const lines = document.getElementById("lines");

const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

host.logic.onMessage((count) => {
  file.textContent = count ? count.path : "No file open";
  file.title = count ? count.path : "";
  if (!count) {
    words.textContent = "–";
    lines.textContent = "";
  } else if (count.error) {
    words.textContent = "–";
    lines.textContent = count.error;
  } else {
    words.textContent = plural(count.words, "word", "words");
    lines.textContent = `${plural(count.lines, "line", "lines")}, as last saved`;
  }
});

document.getElementById("recount").addEventListener("click", () => {
  host.commands.run("count");
});

host.logic.post("hello");
