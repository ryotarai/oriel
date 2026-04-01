export function abbreviateHome(path: string): string {
  if (path.startsWith("/Users/")) {
    const parts = path.split("/");
    return "~" + path.slice(parts.slice(0, 3).join("/").length);
  }
  if (path.startsWith("/home/")) {
    const parts = path.split("/");
    return "~" + path.slice(parts.slice(0, 3).join("/").length);
  }
  return path;
}
