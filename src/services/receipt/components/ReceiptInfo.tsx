import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import { theme } from "../theme.js";

const styles = StyleSheet.create({
  receiptInfoSection: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginBottom: 15,
  },
  receiptInfo: {
    textAlign: "right",
    width: 200,
  },
  receiptInfoRow: {
    fontSize: 16,
    marginBottom: 2,
    textAlign: "right",
    width: "100%",
  },
  receiptInfoLabel: {
    color: theme.colors.secondary,
  },
  receiptInfoValue: {
    color: theme.colors.primary,
  },
});

interface ReceiptInfoProps {
  receiptNo: string;
  date: string;
}

const ReceiptInfo: React.FC<ReceiptInfoProps> = ({ receiptNo, date }) => {
  return (
    <View style={styles.receiptInfoSection}>
      <View style={styles.receiptInfo}>
        <Text style={styles.receiptInfoRow}>
          <Text style={styles.receiptInfoLabel}>เลขที่ </Text>
          <Text style={styles.receiptInfoValue}>{receiptNo}</Text>
        </Text>
        <Text style={styles.receiptInfoRow}>
          <Text style={styles.receiptInfoLabel}>วันที่ </Text>
          <Text style={styles.receiptInfoValue}>{date}</Text>
        </Text>
      </View>
    </View>
  );
};

export default ReceiptInfo;
