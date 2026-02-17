import { describe, test, expect } from "bun:test"
import { createPluginBus } from "../../src/plugin/bus"

describe("PluginBus", () => {
  test("publish and subscribe within same plugin", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    bus.subscribe("alpha", "events", (payload) => {
      received.push(payload)
    })
    await bus.publish("alpha", "events", { key: "value" })
    expect(received).toEqual([{ key: "value" }])
  })

  test("auto-qualifies short topic names", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    // subscribe with short name resolves to alpha.events
    bus.subscribe("alpha", "events", (payload) => {
      received.push(payload)
    })
    // publish with short name also resolves to alpha.events
    await bus.publish("alpha", "events", "hello")
    expect(received).toEqual(["hello"])
  })

  test("cross-plugin subscription with qualified topic", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    // beta subscribes to alpha's topic using qualified name
    bus.subscribe("beta", "alpha.events", (payload) => {
      received.push(payload)
    })
    await bus.publish("alpha", "events", { from: "alpha" })
    expect(received).toEqual([{ from: "alpha" }])
  })

  test("multiple subscribers receive the same message", async () => {
    const bus = createPluginBus()
    const results: string[] = []
    bus.subscribe("alpha", "data", () => {
      results.push("sub1")
    })
    bus.subscribe("beta", "alpha.data", () => {
      results.push("sub2")
    })
    await bus.publish("alpha", "data", null)
    expect(results).toContain("sub1")
    expect(results).toContain("sub2")
    expect(results.length).toBe(2)
  })

  test("unsubscribe stops delivery", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    const { unsubscribe } = bus.subscribe("alpha", "events", (payload) => {
      received.push(payload)
    })
    await bus.publish("alpha", "events", "first")
    unsubscribe()
    await bus.publish("alpha", "events", "second")
    expect(received).toEqual(["first"])
  })

  test("retained messages delivered to late subscribers", async () => {
    const bus = createPluginBus()
    await bus.publish("alpha", "config", { port: 3000 }, { retain: true })

    const received: unknown[] = []
    const { ready } = bus.subscribe("beta", "alpha.config", (payload) => {
      received.push(payload)
    })
    // Await retained delivery via the ready promise (no more setTimeout guessing)
    await ready
    expect(received).toEqual([{ port: 3000 }])
  })

  test("non-retained messages not delivered to late subscribers", async () => {
    const bus = createPluginBus()
    await bus.publish("alpha", "events", "missed")

    const received: unknown[] = []
    bus.subscribe("beta", "alpha.events", (payload) => {
      received.push(payload)
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(received).toEqual([])
  })

  test("handler errors do not break other subscribers", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    bus.subscribe("alpha", "events", () => {
      throw new Error("boom")
    })
    bus.subscribe("beta", "alpha.events", (payload) => {
      received.push(payload)
    })
    await bus.publish("alpha", "events", "test")
    expect(received).toEqual(["test"])
  })

  test("wildcard subscription receives all messages", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    bus.subscribe("monitor", "*", (payload) => {
      received.push(payload)
    })
    await bus.publish("alpha", "events", "a")
    await bus.publish("beta", "data", "b")
    expect(received).toEqual(["a", "b"])
  })

  test("clear removes all subscriptions for a plugin", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    bus.subscribe("alpha", "events", (payload) => {
      received.push(payload)
    })
    bus.subscribe("alpha", "other", (payload) => {
      received.push(payload)
    })
    bus.clear("alpha")
    await bus.publish("alpha", "events", "test")
    await bus.publish("alpha", "other", "test2")
    expect(received).toEqual([])
  })

  test("clear does not affect other plugins", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    bus.subscribe("alpha", "events", () => {
      received.push("alpha")
    })
    bus.subscribe("beta", "alpha.events", () => {
      received.push("beta")
    })
    bus.clear("alpha")
    await bus.publish("alpha", "events", "test")
    expect(received).toEqual(["beta"])
  })

  test("topics returns active topic list", () => {
    const bus = createPluginBus()
    bus.subscribe("alpha", "events", () => {})
    bus.subscribe("beta", "data", () => {})
    const list = bus.topics()
    expect(list).toContain("alpha.events")
    expect(list).toContain("beta.data")
  })

  test("subscriberCount returns correct counts", () => {
    const bus = createPluginBus()
    bus.subscribe("alpha", "events", () => {})
    bus.subscribe("beta", "alpha.events", () => {})
    bus.subscribe("gamma", "*", () => {})
    expect(bus.subscriberCount("alpha.events")).toBe(3) // 2 topic + 1 wildcard (wildcards receive all messages)
    expect(bus.subscriberCount()).toBe(3) // 2 topic + 1 wildcard
  })

  test("async handlers are awaited", async () => {
    const bus = createPluginBus()
    const order: string[] = []
    bus.subscribe("alpha", "events", async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push("async-done")
    })
    await bus.publish("alpha", "events", null)
    expect(order).toEqual(["async-done"])
  })

  test("publish to topic with no subscribers does nothing", async () => {
    const bus = createPluginBus()
    // should not throw
    await bus.publish("alpha", "events", "no-one-listening")
  })

  test("qualified topic is not double-prefixed", async () => {
    const bus = createPluginBus()
    const received: unknown[] = []
    bus.subscribe("alpha", "beta.data", (payload) => {
      received.push(payload)
    })
    await bus.publish("beta", "data", "hello")
    expect(received).toEqual(["hello"])
  })

  test("clear purges retained messages for cleared plugin", async () => {
    const bus = createPluginBus()
    await bus.publish("alpha", "config", { retained: true }, { retain: true })
    bus.clear("alpha")

    // Late subscriber should NOT receive the retained message after clear
    const received: unknown[] = []
    const { ready } = bus.subscribe("beta", "alpha.config", (payload) => {
      received.push(payload)
    })
    await ready
    expect(received).toEqual([])
  })

  test("clear does not purge retained messages from other plugins", async () => {
    const bus = createPluginBus()
    await bus.publish("alpha", "data", "alpha-msg", { retain: true })
    await bus.publish("beta", "data", "beta-msg", { retain: true })
    bus.clear("alpha")

    // beta's retained message should still be delivered
    const received: unknown[] = []
    const { ready } = bus.subscribe("gamma", "beta.data", (payload) => {
      received.push(payload)
    })
    await ready
    expect(received).toEqual(["beta-msg"])
  })

  test("subscriberCount with topic includes wildcards", () => {
    const bus = createPluginBus()
    bus.subscribe("alpha", "events", () => {})
    bus.subscribe("beta", "*", () => {})
    // Per-topic count includes both the specific subscriber and the wildcard
    expect(bus.subscriberCount("alpha.events")).toBe(2)
  })
})
