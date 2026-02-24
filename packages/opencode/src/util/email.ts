export namespace Email {
  const PATTERN =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/
  const MAX_LENGTH = 254

  export function validate(input: string) {
    if (!input) return false
    if (input.length > MAX_LENGTH) return false
    return PATTERN.test(input)
  }
}
