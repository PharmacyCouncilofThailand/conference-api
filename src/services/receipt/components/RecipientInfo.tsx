import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import { theme } from "../theme.js";
import { Recipient } from "../types.js";

const styles = StyleSheet.create({
  recipientSection: {
    marginBottom: 10,
  },
  recipientRow: {
    flexDirection: "row",
    marginBottom: 6,
    fontSize: 16,
  },
  recipientLabel: {
    color: theme.colors.secondary,
    marginRight: 20,
  },
  recipientValue: {
    color: theme.colors.primary,
    flex: 1,
  },
});

interface RecipientInfoProps {
  recipient: Recipient;
}

const RecipientInfo: React.FC<RecipientInfoProps> = ({ recipient }) => {
  return (
    <View style={styles.recipientSection}>
      <View style={styles.recipientRow}>
        <Text style={styles.recipientLabel}>ได้รับเงินจาก</Text>
        <Text style={styles.recipientValue}>{recipient.name}</Text>
      </View>
      {recipient.idNumber ? (
        <View style={styles.recipientRow}>
          <Text style={styles.recipientLabel}>เลขประจำตัวผู้เสียภาษี</Text>
          <Text style={styles.recipientValue}>{recipient.idNumber}</Text>
        </View>
      ) : null}
      {recipient.address ? (
        <View style={styles.recipientRow}>
          <Text style={styles.recipientLabel}>ที่อยู่</Text>
          <Text style={styles.recipientValue}>{recipient.address}</Text>
        </View>
      ) : null}
    </View>
  );
};

export default RecipientInfo;
