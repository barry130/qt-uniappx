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

export type TurntableStyles = {
  canvasSize: string;
  recordSize: string;
  plate: string;
  cover: string;
};

/** 原生 image 和旋转容器使用同一组明确尺寸，不依赖绝对定位中的百分比高度。 */
export function turntableStyles(metrics: TurntableMetrics, unit: number): TurntableStyles {
  const px = (rpx: number): string => (rpx * unit).toFixed(2) + "px";
  const recordSize = "width:" + px(metrics.recordRpx) + ";height:" + px(metrics.recordRpx) + ";border-radius:" + px(metrics.recordRpx / 2) + ";";
  const coverOffset = (metrics.recordRpx - metrics.coverRpx) / 2;
  return {
    canvasSize: "width:" + px(metrics.widthRpx) + ";height:" + px(metrics.heightRpx) + ";",
    recordSize,
    plate: "position:absolute;left:" + px(metrics.recordLeftRpx) + ";top:" + px(metrics.recordTopRpx) + ";" + recordSize,
    cover: "position:absolute;left:" + px(coverOffset) + ";top:" + px(coverOffset) + ";width:" + px(metrics.coverRpx) + ";height:" + px(metrics.coverRpx) + ";border-radius:" + px(metrics.coverRpx / 2) + ";",
  };
}
