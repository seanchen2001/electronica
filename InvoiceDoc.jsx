import React from "react";
import { Document, Page, View, Text, StyleSheet } from "@react-pdf/renderer";

// Factura / Remito PDF — replicates the trader's template.
// mode "remito" hides Unit Price, Line Total and the money totals.

const money = (n) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BORDER = "#000";
const s = StyleSheet.create({
  page: { padding: 22, fontSize: 9, fontFamily: "Helvetica", color: "#111" },
  // header
  headerRow: { flexDirection: "row", borderWidth: 1, borderColor: BORDER },
  headerLeft: { flex: 1, padding: 10, justifyContent: "center" },
  company: { fontSize: 15, fontFamily: "Helvetica-Bold" },
  metaBox: { width: 220, borderLeftWidth: 1, borderColor: BORDER },
  metaRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: BORDER },
  metaK: { width: 80, padding: 4, fontFamily: "Helvetica-Bold", borderRightWidth: 1, borderColor: BORDER },
  metaV: { flex: 1, padding: 4 },
  // To
  toBox: { flexDirection: "row", borderWidth: 1, borderTopWidth: 0, borderColor: BORDER },
  toLabel: { width: 40, padding: 6, borderRightWidth: 1, borderColor: BORDER },
  toContent: { flex: 1, padding: 6 },
  clientName: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  clientLine: { marginBottom: 1 },
  // salesperson grid
  spHeader: { flexDirection: "row", borderWidth: 1, borderTopWidth: 0, borderColor: BORDER },
  spRow: { flexDirection: "row", borderWidth: 1, borderTopWidth: 0, borderColor: BORDER, minHeight: 16 },
  spCell: { flex: 1, padding: 4, borderRightWidth: 1, borderColor: BORDER },
  spLabel: { fontSize: 8, color: "#333" },
  // items
  itHeader: { flexDirection: "row", borderWidth: 1, borderTopWidth: 0, borderColor: BORDER, backgroundColor: "#f1f1f1" },
  itRow: { flexDirection: "row", borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: BORDER, minHeight: 16 },
  itQty: { width: 60, padding: 4, textAlign: "center", borderRightWidth: 1, borderColor: BORDER },
  itDesc: { flex: 1, padding: 4, borderRightWidth: 1, borderColor: BORDER },
  itPrice: { width: 90, padding: 4, textAlign: "right", borderRightWidth: 1, borderColor: BORDER },
  itTotal: { width: 100, padding: 4, textAlign: "right" },
  hLabel: { fontFamily: "Helvetica-Bold", fontSize: 8 },
  // totals
  totalsRow: { flexDirection: "row", borderLeftWidth: 1, borderRightWidth: 1, borderBottomWidth: 1, borderColor: BORDER },
  piezasBox: { flex: 1, flexDirection: "row", padding: 6, alignItems: "center", borderRightWidth: 1, borderColor: BORDER },
  piezasLabel: { marginRight: 8 },
  piezasVal: { fontFamily: "Helvetica-Bold", fontSize: 12 },
  totBox: { width: 190 },
  totLine: { flexDirection: "row", borderBottomWidth: 1, borderColor: BORDER },
  totK: { flex: 1, padding: 4, textAlign: "right", borderRightWidth: 1, borderColor: BORDER },
  totV: { width: 90, padding: 4, textAlign: "right" },
  bold: { fontFamily: "Helvetica-Bold" },
  // shipping
  shipBox: { marginTop: 14, borderWidth: 1.5, borderColor: BORDER, width: "70%" },
  shipHead: { textAlign: "center", fontFamily: "Helvetica-Bold", padding: 4, borderBottomWidth: 1, borderColor: BORDER },
  shipRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: BORDER },
  shipK: { width: 80, padding: 4, fontFamily: "Helvetica-Bold", textAlign: "right", borderRightWidth: 1, borderColor: BORDER },
  shipV: { flex: 1, padding: 4, fontFamily: "Helvetica-Bold" },
  footer: { marginTop: 26, textAlign: "center", fontSize: 11, color: "#444" },
});

export default function InvoiceDoc({ company, client, order, mode }) {
  const remito = mode === "remito";
  const items = order.items || [];
  const totalPiezas = items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const subtotal = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const shipping = Number(order.shippingCost) || 0;
  const total = subtotal + shipping;
  const hasShip = client.notify || client.direccion || client.telefono || client.contacto;
  const meta = [
    ["Date:", order.date],
    ["Invoice #:", order.invoiceNo],
    ["Payment:", order.payment],
    ["FOB:", order.fob],
  ];

  return (
    <Document>
      <Page size="LETTER" style={s.page}>
        <View style={s.headerRow}>
          <View style={s.headerLeft}>
            <Text style={s.company}>{company.name}</Text>
          </View>
          <View style={s.metaBox}>
            {meta.map(([k, v]) => (
              <View style={s.metaRow} key={k}>
                <Text style={s.metaK}>{k}</Text>
                <Text style={s.metaV}>{v}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={s.toBox}>
          <Text style={s.toLabel}>To:</Text>
          <View style={s.toContent}>
            <Text style={s.clientName}>{client.name}</Text>
            {(client.addressLines || []).map((l, i) => (
              <Text style={s.clientLine} key={i}>{l}</Text>
            ))}
            {client.ruc ? <Text style={s.clientLine}>RUC: {client.ruc}</Text> : null}
            {client.phone ? <Text style={s.clientLine}>Telefono: {client.phone}</Text> : null}
          </View>
        </View>

        <View style={s.spHeader}>
          {["Salesperson", "Job", "Payment Terms", "Due Date"].map((l) => (
            <Text style={[s.spCell, s.spLabel]} key={l}>{l}</Text>
          ))}
        </View>
        <View style={s.spRow}>
          <Text style={s.spCell}>{order.salesperson}</Text>
          <Text style={s.spCell}>{order.job || ""}</Text>
          <Text style={s.spCell}>{order.terms}</Text>
          <Text style={[s.spCell, { borderRightWidth: 0 }]}>{order.dueDate}</Text>
        </View>

        <View style={s.itHeader}>
          <Text style={[s.itQty, s.hLabel]}>Qty</Text>
          <Text style={[s.itDesc, s.hLabel]}>Description</Text>
          {!remito && <Text style={[s.itPrice, s.hLabel]}>Unit Price</Text>}
          {!remito && <Text style={[s.itTotal, s.hLabel]}>Line Total</Text>}
        </View>
        {items.map((it, idx) => (
          <View style={s.itRow} key={idx}>
            <Text style={s.itQty}>{it.qty}</Text>
            <Text style={[s.itDesc, remito ? {} : null]}>{it.sku}</Text>
            {!remito && <Text style={s.itPrice}>{money(it.price)}</Text>}
            {!remito && <Text style={s.itTotal}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</Text>}
          </View>
        ))}

        <View style={s.totalsRow}>
          <View style={s.piezasBox}>
            <Text style={s.piezasLabel}>Total Piezas:</Text>
            <Text style={s.piezasVal}>{totalPiezas}</Text>
          </View>
          {!remito && (
            <View style={s.totBox}>
              <View style={s.totLine}><Text style={s.totK}>Subtotal</Text><Text style={s.totV}>{money(subtotal)}</Text></View>
              <View style={s.totLine}><Text style={s.totK}>Shipping</Text><Text style={s.totV}>{shipping ? money(shipping) : ""}</Text></View>
              <View style={[s.totLine, { borderBottomWidth: 0 }]}><Text style={[s.totK, s.bold]}>Total</Text><Text style={[s.totV, s.bold]}>{money(total)}</Text></View>
            </View>
          )}
        </View>

        {hasShip ? (
          <View style={s.shipBox}>
            <Text style={s.shipHead}>Shipping</Text>
            {[["Notify:", client.notify], ["Direccion:", client.direccion], ["Telefono:", client.telefono], ["Contacto:", client.contacto]].map(([k, v]) => (
              <View style={s.shipRow} key={k}>
                <Text style={s.shipK}>{k}</Text>
                <Text style={s.shipV}>{v || ""}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={s.footer}>Thank you for your business!</Text>
      </Page>
    </Document>
  );
}
