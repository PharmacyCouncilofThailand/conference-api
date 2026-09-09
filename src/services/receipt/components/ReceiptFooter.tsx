import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import { theme } from "../theme.js";

const styles = StyleSheet.create({
  paymentSection: {
    fontSize: 16,
    color: theme.colors.secondary,
    marginTop: 8,
  },
  paymentNote: {
    fontSize: 16,
    color: theme.colors.secondary,
  },
});

interface ReceiptFooterProps {
  paymentMethod: string;
  paymentDate: string;
  paymentTime: string;
  footerNote: string;
}

const ReceiptFooter: React.FC<ReceiptFooterProps> = ({
  paymentMethod,
  paymentDate,
  paymentTime,
  footerNote,
}) => {
  return (
    <>
      <View style={styles.paymentSection}>
        <Text>
          ชำระโดย : {paymentMethod} วันที่ชำระ {paymentDate} เวลา {paymentTime} น.
        </Text>
        <Text style={styles.paymentNote}>{footerNote}</Text>
      </View>
    </>
  );
};

export default ReceiptFooter;
