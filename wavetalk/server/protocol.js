export const JOIN = "join";
export const CHAT = "chat";
export const TYPING = "typing";

export const JOIN_OK = "join_ok";
export const JOIN_ERROR = "join_error";
export const MESSAGE = "message";
export const SYSTEM = "system";
export const ROSTER = "roster";
export const TYPING_UPDATE = "typing_update";

export const MAX_NAME = 16;
export const MAX_MESSAGE = 500;

export function encode(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

export function decode(raw) {
  try {
    const data = JSON.parse(raw);
    return typeof data.type === "string" ? data : null;
  } catch {
    return null;
  }
}

export function validateName(name) {
  if (typeof name !== "string") return "Name is required";
  const clean = name.trim();
  if (clean.length < 2) return "Name must be at least 2 characters";
  if (clean.length > MAX_NAME) return `Name must be under ${MAX_NAME} characters`;
  if (!/^[a-zA-Z0-9_ ]+$/.test(clean)) return "Letters, numbers and underscore only";
  return null;
}