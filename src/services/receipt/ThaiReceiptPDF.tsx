import React from "react";
import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";
import { theme } from "./theme.js";
import { numberToThaiText } from "./thaiBaht.js";
import PDFLogo from "./components/PDFLogo.js";
import PDFWatermark from "./components/PDFWatermark.js";
import ReceiptHeader from "./components/ReceiptHeader.js";
import ReceiptInfo from "./components/ReceiptInfo.js";
import RecipientInfo from "./components/RecipientInfo.js";
import ReceiptTable from "./components/ReceiptTable.js";
import ReceiptFooter from "./components/ReceiptFooter.js";
import { ReceiptViewData } from "./types.js";

const styles = StyleSheet.create({
  page: {
    padding: theme.spacing.padding,
    paddingTop: 60,
    fontSize: theme.fontSizes.body,
    fontFamily: theme.fonts.main,
    color: theme.colors.primary,
    backgroundColor: theme.colors.white,
  },
  watermark: {
    position: "absolute",
    top: "33%",
    left: "25%",
    width: 300,
    height: 400,
  },
  logoPositionable: {
    position: "absolute",
    width: 200,
    height: 200,
  },
  titleSection: {
    alignItems: "center",
    marginVertical: 15,
  },
  receiptTitle: {
    fontSize: theme.fontSizes.h2,
    fontWeight: "bold",
    color: theme.colors.primary,
  },
});

interface ThaiReceiptPDFProps {
  receipt: ReceiptViewData;
}

const ThaiReceiptPDF: React.FC<ThaiReceiptPDFProps> = ({ receipt }) => {
  const totalInWords = numberToThaiText(receipt.netTotal);

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        {/* Watermark - center of page */}
        <View style={styles.watermark}>
          <PDFWatermark width={300} height={400} opacity={0.3} />
        </View>

        {/* Logo - absolute positioned */}
        <View style={[styles.logoPositionable, { top: 10, left: 40 }]}>
          <PDFLogo width={60} height={80} />
        </View>

        {/* Header */}
        <ReceiptHeader organization={receipt.organization} />

        {/* Title */}
        <View style={styles.titleSection}>
          <Text style={styles.receiptTitle}>ใบเสร็จรับเงิน</Text>
        </View>

        {/* Receipt no / date (right aligned) */}
        <ReceiptInfo receiptNo={receipt.receiptNo} date={receipt.date} />

        {/* Recipient */}
        <RecipientInfo recipient={receipt.recipient} />

        {/* Items table + summary */}
        <ReceiptTable
          items={receipt.items}
          subtotal={receipt.subtotal}
          discount={receipt.discount}
          promoCode={receipt.promoCode}
          fee={receipt.fee}
          netTotal={receipt.netTotal}
          totalInWords={totalInWords}
        />

        {/* Payment info + signatures */}
        <ReceiptFooter
          paymentMethod={receipt.paymentMethod}
          paymentDate={receipt.paymentDate}
          paymentTime={receipt.paymentTime}
          footerNote={receipt.footerNote}
        />
      </Page>
    </Document>
  );
};

export default ThaiReceiptPDF;
