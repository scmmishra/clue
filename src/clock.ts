// Monotonic timing from Bun's native clock: nanoseconds since the process started.
// Wall-clock timestamps for display still use Date.now().

export const now = () => Bun.nanoseconds();

// Milliseconds since a value returned by now().
export const msSince = (start: number) => (Bun.nanoseconds() - start) / 1e6;

// Milliseconds since the process started.
export const uptimeMs = () => Bun.nanoseconds() / 1e6;
