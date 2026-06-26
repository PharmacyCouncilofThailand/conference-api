import React from "react";
import { PDFLogoIcon } from "./PDFLogoIcon.js";

interface PDFLogoProps {
  width?: number;
  height?: number;
  primaryColor?: string;
}

const PDFLogo: React.FC<PDFLogoProps> = ({
  width = 200,
  height = 110,
  primaryColor = "rgb(116,118,27)",
}) => {
  return <PDFLogoIcon width={width} height={height} color={primaryColor} />;
};

export default PDFLogo;
