/**
 * What every detector returns: the value it found, and where it came from.
 * Detectors report; they never decide and never write.
 */
export type Detection<T> = {
  value: T;
  source: string;
  /** What the detector could not do, and how to do it by hand; only where it has something to say. */
  hint?: string;
};
