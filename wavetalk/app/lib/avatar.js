const PALETTE = [
  { bg: "#CECBF6", fg: "#26215C" },
  { bg: "#9FE1CB", fg: "#04342C" },
  { bg: "#F5C4B3", fg: "#4A1B0C" },
  { bg: "#F4C0D1", fg: "#4B1528" },
  { bg: "#B5D4F4", fg: "#042C53" },
  { bg: "#FAC775", fg: "#412402" },
];

export function colorFor(name = "") {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function initials(name = "") {
  return name.slice(0, 2).toUpperCase();
}

export function clockTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}