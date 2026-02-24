import { describe, expect, test } from "bun:test"
import { Email } from "../../src/util/email"

describe("util.email", () => {
  test("accepts standard email addresses", () => {
    expect(Email.validate("user@example.com")).toBe(true)
    expect(Email.validate("test@sub.domain.com")).toBe(true)
    expect(Email.validate("name@domain.org")).toBe(true)
  })

  test("accepts emails with special local characters", () => {
    expect(Email.validate("user.name@example.com")).toBe(true)
    expect(Email.validate("user+tag@example.com")).toBe(true)
    expect(Email.validate("user!def@example.com")).toBe(true)
    expect(Email.validate("user#hash@example.com")).toBe(true)
  })

  test("accepts single character local and domain parts", () => {
    expect(Email.validate("a@b.c")).toBe(true)
    expect(Email.validate("x@y")).toBe(true)
  })

  test("rejects empty string", () => {
    expect(Email.validate("")).toBe(false)
  })

  test("rejects missing @ symbol", () => {
    expect(Email.validate("userexample.com")).toBe(false)
    expect(Email.validate("plaintext")).toBe(false)
  })

  test("rejects missing local part", () => {
    expect(Email.validate("@example.com")).toBe(false)
  })

  test("rejects missing domain", () => {
    expect(Email.validate("user@")).toBe(false)
  })

  test("rejects multiple @ symbols", () => {
    expect(Email.validate("user@@example.com")).toBe(false)
    expect(Email.validate("user@name@example.com")).toBe(false)
  })

  test("rejects spaces", () => {
    expect(Email.validate("user @example.com")).toBe(false)
    expect(Email.validate("user@ example.com")).toBe(false)
    expect(Email.validate(" user@example.com")).toBe(false)
  })

  test("rejects domain starting or ending with hyphen", () => {
    expect(Email.validate("user@-example.com")).toBe(false)
    expect(Email.validate("user@example-.com")).toBe(false)
  })

  test("rejects addresses exceeding 254 characters", () => {
    const long = "a".repeat(245) + "@example.com"
    expect(long.length).toBeGreaterThan(254)
    expect(Email.validate(long)).toBe(false)
  })

  test("accepts address at exactly 254 characters", () => {
    const local = "a".repeat(242)
    const address = local + "@example.com"
    expect(address.length).toBe(254)
    expect(Email.validate(address)).toBe(true)
  })
})
