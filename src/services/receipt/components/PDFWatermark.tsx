import React from "react";
import { View } from "@react-pdf/renderer";
import { PDFWatermarkIcon } from "./PDFWatermarkIcon.js";

interface PDFWatermarkProps {
  width?: number;
  height?: number;
  opacity?: number;
}

const PDFWatermark: React.FC<PDFWatermarkProps> = ({
  width = 779,
  height = 1078,
  opacity = 0.5,
}) => {
  return (
    <View>
      <PDFWatermarkIcon width={width} height={height} color="#727300" opacity={opacity} />
    </View>
  );
};

export default PDFWatermark;
