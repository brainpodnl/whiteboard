import { env } from "./env";

function emit(level: string, message: string, fields?: Record<string, unknown>) {
  const parts = [`[${env.podId}]`, level.padEnd(5), message];
  if (fields) parts.push(JSON.stringify(fields));
  const line = parts.join(" ");
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (message: string, fields?: Record<string, unknown>) =>
    emit("info", message, fields),
  warn: (message: string, fields?: Record<string, unknown>) =>
    emit("warn", message, fields),
  error: (message: string, fields?: Record<string, unknown>) =>
    emit("error", message, fields),
};
