export function base64Encode(value: string) {
  if (value.startsWith("/workspace/repos/")) return value.replace("/workspace/repos/", "")
  return value
}

export function base64Decode(value: string) {
  if (!value) return "/"
  if (value.startsWith("/workspace/repos/")) return value
  return `/workspace/repos/${value}`
}
