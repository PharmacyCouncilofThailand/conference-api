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
  remarks: {
    marginTop: 8,
    fontSize: 16,
    color: theme.colors.secondary,
  },
});

export const RECEIPT_REMARKS = [
  "เอกสารฉบับนี้จัดทำและตรวจสอบด้วยระบบคอมพิวเตอร์ ถือว่าสมบูรณ์โดยไม่ต้องมีลายมือชื่อ ผู้รับมอบอำนาจ",
  "เอกสารฉบับนี้จะถือว่าเป็นใบเสร็จรับเงินได้ ต่อเมื่อทางสภาเภสัชกรรมได้รับเงินถูกต้องครบถ้วนตามที่ระบุ ไว้ข้างต้นแล้วเท่านั้น",
];

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
      <View style={styles.remarks} wrap={false}>
        <Text>หมายเหตุ</Text>
        {RECEIPT_REMARKS.map((remark, index) => (
          <Text key={index}>
            {index + 1}. {remark}
          </Text>
        ))}
      </View>
    </>
  );
};

export default ReceiptFooter;
