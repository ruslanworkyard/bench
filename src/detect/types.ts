/**
 * What every detector returns: the value it found, and where it came from.
 * Detectors report; they never decide and never write.
 */
export type Detection<T> = { value: T; source: string };
