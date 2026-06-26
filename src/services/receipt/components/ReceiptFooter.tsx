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
  footer: {
    marginTop: 20,
  },
  footerTitle: {
    textAlign: "right",
    marginRight: 215,
    fontSize: 16,
  },
  signatureRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  signatureBlock: {
    alignItems: "center",
    width: "40%",
  },
  signatureParentheses: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-end",
    width: "100%",
    marginBottom: 5,
  },
  signatureParen: {
    fontSize: 16,
    color: theme.colors.primary,
  },
  signatureSpace: {
    width: 150,
    fontSize: 16,
  },
  signatureLabel: {
    fontSize: 16,
    color: theme.colors.primary,
    textAlign: "center",
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

      <View style={styles.footer}>
        <Text style={styles.footerTitle}>ผู้รับเงิน</Text>
        <View style={styles.signatureRow}>
          <View style={styles.signatureBlock}>
            <View style={styles.signatureParentheses}>
              <Text style={styles.signatureParen}>(</Text>
              <Text style={styles.signatureSpace}> </Text>
              <Text style={styles.signatureParen}>)</Text>
            </View>
            <Text style={styles.signatureLabel}>เหรัญญิกสภาเภสัชกรรม</Text>
          </View>
          <View style={styles.signatureBlock}>
            <View style={styles.signatureParentheses}>
              <Text style={styles.signatureParen}>(</Text>
              <Text style={styles.signatureSpace}> </Text>
              <Text style={styles.signatureParen}>)</Text>
            </View>
            <Text style={styles.signatureLabel}>
              เจ้าหน้าที่การเงินสภาเภสัชกรรม
            </Text>
          </View>
        </View>
      </View>
    </>
  );
};

export default ReceiptFooter;
