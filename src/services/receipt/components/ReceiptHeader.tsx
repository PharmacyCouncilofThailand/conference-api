import React from "react";
import { View, Text, StyleSheet } from "@react-pdf/renderer";
import { theme } from "../theme.js";
import { Organization } from "../types.js";

const styles = StyleSheet.create({
  header: {
    flexDirection: "column",
    alignItems: "center",
    marginTop: -30,
  },
  orgInfo: {
    alignItems: "center",
    width: "100%",
  },
  orgName: {
    fontSize: theme.fontSizes.h1,
    fontWeight: "bold",
    color: theme.colors.accent,
    marginBottom: 3,
    textAlign: "center",
  },
  orgAddress: {
    fontSize: 16,
    color: theme.colors.secondary,
    textAlign: "center",
    lineHeight: 1.4,
  },
});

interface ReceiptHeaderProps {
  organization: Organization;
}

const ReceiptHeader: React.FC<ReceiptHeaderProps> = ({ organization }) => {
  return (
    <View style={styles.header}>
      <View style={styles.orgInfo}>
        <Text style={styles.orgName}>{organization.name}</Text>
        <Text style={styles.orgAddress}>{organization.address1}</Text>
        <Text style={styles.orgAddress}>
          {organization.address2} {organization.phone}
        </Text>
        <Text style={styles.orgAddress}>
          Website: {organization.website} Email: {organization.email} Tax ID:{" "}
          {organization.taxId}
        </Text>
      </View>
    </View>
  );
};

export default ReceiptHeader;
