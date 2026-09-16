// How much a handoff may be. One number, used by the writer and by resume, so they cannot disagree.

/**
 * About what one command output shows whole. Past this the app swaps the output for a short preview,
 * so anything longer reaches the next session only as a pointer to the file on disk.
 */
export const ONE_READ_BYTES = 27_000;

/** What resume prints above the handoff: its own lines, at their longest. */
const RESUME_LINES_BYTES = 1_500;

/** The handoff's share of one read. The writer shrinks to this; resume cuts at ONE_READ_BYTES. */
export const HANDOFF_BYTES = ONE_READ_BYTES - RESUME_LINES_BYTES;
