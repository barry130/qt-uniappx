/** All material assets use the same normalized 2000×1800 design canvas. */
export type TurntableMetrics = {
  widthRpx: number;
  heightRpx: number;
  recordLeftRpx: number;
  recordTopRpx: number;
  recordRpx: number;
  coverRpx: number;
};

/** The caller allocates the ENTIRE assembly height, not just the vinyl diameter. */
export function turntableMetrics(heightRpx: number): TurntableMetrics {
  const height = Math.max(0, heightRpx);
  const width = height / 0.9;
  const record = width * 0.78;
  return {
    widthRpx: width,
    heightRpx: height,
    recordLeftRpx: width * 0.09,
    recordTopRpx: width * 0.085,
    recordRpx: record,
    coverRpx: record * 0.46,
  };
}
