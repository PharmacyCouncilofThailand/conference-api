import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import { theme, fmtMoney } from "../theme.js";
import { ReceiptItem } from "../types.js";

const styles = StyleSheet.create({
  table: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    minHeight: 300,
  },
  tableHeader: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tableHeaderCell: {
    fontWeight: "bold",
    fontSize: 16,
    color: theme.colors.primary,
    textAlign: "center",
    justifyContent: "center",
    paddingVertical: 6,
  },
  tableRow: {
    flexDirection: "row",
  },
  tableRowLast: {
    flexDirection: "row",
    flex: 1,
  },
  tableCell: {
    fontSize: 16,
    color: theme.colors.primary,
    textAlign: "center",
    paddingVertical: 6,
  },
  // Summary rows (subtotal / discount / fee).
  // The top divider line only spans the จำนวน column onward (not the left
  // รายการ cell), so borderTop is on the label/value cells — not the row.
  summaryRow: {
    flexDirection: "row",
  },
  summaryBlank: {
    width: "60%",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  summaryLabel: {
    width: "25%",
    textAlign: "right",
    paddingRight: 8,
    paddingVertical: 6,
    fontSize: 16,
    color: theme.colors.secondary,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  summaryValue: {
    width: "15%",
    textAlign: "center",
    paddingVertical: 6,
    fontSize: 16,
    color: theme.colors.primary,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  // Footer total row
  tableFooterRow: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  tableFooterLeft: {
    width: "60%",
    textAlign: "left",
    paddingLeft: 10,
    paddingVertical: 6,
    fontSize: 16,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  tableFooterCenter: {
    width: "25%",
    textAlign: "center",
    paddingVertical: 6,
    fontSize: 16,
    fontWeight: "bold",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  tableFooterRight: {
    width: "15%",
    textAlign: "center",
    paddingVertical: 6,
    fontSize: 16,
    fontWeight: "bold",
  },
  // Column widths
  colItem: {
    width: "60%",
    textAlign: "left",
    paddingLeft: 10,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  colQty: {
    width: "10%",
    textAlign: "center",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  colUnit: {
    width: "15%",
    textAlign: "center",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  colAmount: { width: "15%", textAlign: "center" },
  colHeaderItem: {
    width: "60%",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  colHeaderQty: {
    width: "10%",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  colHeaderUnit: {
    width: "15%",
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  colHeaderAmount: { width: "15%" },
});

interface ReceiptTableProps {
  items: ReceiptItem[];
  subtotal: number;
  discount: number;
  promoCode?: string | null;
  fee: number;
  netTotal: number;
  totalInWords: string;
}

const ReceiptTable: React.FC<ReceiptTableProps> = ({
  items,
  subtotal,
  discount,
  promoCode,
  fee,
  netTotal,
  totalInWords,
}) => {
  const hasAdjustments = discount > 0 || fee > 0;

  return (
    <View style={styles.table}>
      {/* Header */}
      <View style={styles.tableHeader}>
        <Text style={[styles.tableHeaderCell, styles.colHeaderItem]}>รายการ</Text>
        <Text style={[styles.tableHeaderCell, styles.colHeaderQty]}>จำนวน</Text>
        <Text style={[styles.tableHeaderCell, styles.colHeaderUnit]}>หน่วยละ</Text>
        <Text style={[styles.tableHeaderCell, styles.colHeaderAmount]}>
          จำนวนเงิน
        </Text>
      </View>

      {/* Item rows */}
      {items.map((item, index) => (
        <View key={index} style={styles.tableRow}>
          <Text style={[styles.tableCell, styles.colItem]}>
            {item.description}
          </Text>
          <Text style={[styles.tableCell, styles.colQty]}>{item.quantity}</Text>
          <Text style={[styles.tableCell, styles.colUnit]}>
            {fmtMoney(item.unitPrice)}
          </Text>
          <Text style={[styles.tableCell, styles.colAmount]}>
            {fmtMoney(item.amount)}
          </Text>
        </View>
      ))}

      {/* Filler to push totals to the bottom */}
      <View style={styles.tableRowLast}>
        <Text style={[styles.tableCell, styles.colItem]}> </Text>
        <Text style={[styles.tableCell, styles.colQty]}> </Text>
        <Text style={[styles.tableCell, styles.colUnit]}> </Text>
        <Text style={[styles.tableCell, styles.colAmount]}> </Text>
      </View>

      {/* Summary rows (only when there is a discount or fee) */}
      {hasAdjustments ? (
        <>
          <View style={styles.summaryRow}>
            <Text style={styles.summaryBlank}> </Text>
            <Text style={styles.summaryLabel}>รวมเป็นเงิน</Text>
            <Text style={styles.summaryValue}>{fmtMoney(subtotal)}</Text>
          </View>
          {discount > 0 ? (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryBlank}> </Text>
              <Text style={styles.summaryLabel}>
                ส่วนลด{promoCode ? ` (${promoCode})` : ""}
              </Text>
              <Text style={styles.summaryValue}>-{fmtMoney(discount)}</Text>
            </View>
          ) : null}
          {fee > 0 ? (
            <View style={styles.summaryRow}>
              <Text style={styles.summaryBlank}> </Text>
              <Text style={styles.summaryLabel}>ค่าธรรมเนียมการชำระเงิน</Text>
              <Text style={styles.summaryValue}>{fmtMoney(fee)}</Text>
            </View>
          ) : null}
        </>
      ) : null}

      {/* Footer total row */}
      <View style={styles.tableFooterRow}>
        <Text style={styles.tableFooterLeft}>
          จำนวนเงินตัวอักษร ({totalInWords})
        </Text>
        <Text style={styles.tableFooterCenter}>รวมจำนวนเงิน</Text>
        <Text style={styles.tableFooterRight}>{fmtMoney(netTotal)}</Text>
      </View>
    </View>
  );
};

export default ReceiptTable;
