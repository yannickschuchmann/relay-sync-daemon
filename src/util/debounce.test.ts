import { describe, test, expect } from "bun:test";
import { debounce, debounceCancellable } from "./debounce";

describe("debounce", () => {
  test("calls function after delay", async () => {
    let callCount = 0;
    const debounced = debounce(() => {
      callCount++;
    }, 50);

    debounced();
    expect(callCount).toBe(0);

    await Bun.sleep(80);
    expect(callCount).toBe(1);
  });

  test("resets timer on subsequent calls (only last call executes)", async () => {
    let callCount = 0;
    const debounced = debounce(() => {
      callCount++;
    }, 50);

    debounced();
    await Bun.sleep(30);
    debounced(); // reset the timer
    await Bun.sleep(30);
    // at this point ~60ms since first call but only ~30ms since second
    expect(callCount).toBe(0);

    await Bun.sleep(40);
    // now ~70ms since the second call
    expect(callCount).toBe(1);
  });

  test("passes arguments correctly", async () => {
    const receivedArgs: Array<[string, number]> = [];
    const debounced = debounce((a: string, b: number) => {
      receivedArgs.push([a, b]);
    }, 50);

    debounced("first", 1);
    debounced("second", 2);

    await Bun.sleep(80);
    expect(receivedArgs).toEqual([["second", 2]]);
  });
});

describe("debounceCancellable", () => {
  test("call() triggers function after delay", async () => {
    let callCount = 0;
    const { call } = debounceCancellable(() => {
      callCount++;
    }, 50);

    call();
    expect(callCount).toBe(0);

    await Bun.sleep(80);
    expect(callCount).toBe(1);
  });

  test("cancel() prevents pending execution", async () => {
    let callCount = 0;
    const { call, cancel } = debounceCancellable(() => {
      callCount++;
    }, 50);

    call();
    await Bun.sleep(20);
    cancel();

    await Bun.sleep(60);
    expect(callCount).toBe(0);
  });

  test("flush() immediately executes pending call", async () => {
    let callCount = 0;
    const receivedArgs: string[] = [];
    const { call, flush } = debounceCancellable((val: string) => {
      callCount++;
      receivedArgs.push(val);
    }, 50);

    call("flushed");
    expect(callCount).toBe(0);

    flush();
    expect(callCount).toBe(1);
    expect(receivedArgs).toEqual(["flushed"]);

    // The timer should be cleared after flush, so no duplicate call
    await Bun.sleep(80);
    expect(callCount).toBe(1);
  });

  test("flush() does nothing if no pending call", () => {
    let callCount = 0;
    const { flush } = debounceCancellable(() => {
      callCount++;
    }, 50);

    flush();
    expect(callCount).toBe(0);
  });
});
