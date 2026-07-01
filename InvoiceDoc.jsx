import React from "react";
import { Document, Page, View, Text, Image, StyleSheet } from "@react-pdf/renderer";
import { LOGO } from "./logo.js";

// Factura / Remito PDF — clean layout matching the trader's template:
// outer border, no grid in the items table, gray "Line Total" band, blank
// Qty/Unit Price headers, generous whitespace. mode "remito" hides prices/totals.

const money = (n) =>
  "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Descripción para la factura: "Samsung A07 4+64 DS - COLOR - SPEC".
// El proveedor NUNCA va acá (es interno). Marca = Samsung para esa categoría;
// los Motorola ya traen la marca en el nombre.
function itemDesc(it) {
  const brand = it.cat === "Samsung" ? "Samsung " : "";
  return [brand + it.sku, it.color, it.spec].filter((x) => x && String(x).trim()).join(" - ");
}
const GRAY = "#f0f0f0";
const BLACK = "#000";

const s = StyleSheet.create({
  page: { padding: 20, fontSize: 9.5, fontFamily: "Helvetica", color: BLACK },
  outer: { borderWidth: 1, borderColor: BLACK },

  // header
  header: { flexDirection: "row", borderBottomWidth: 1, borderColor: BLACK },
  headerLeft: { flex: 1, flexDirection: "row", alignItems: "center", padding: 12 },
  logo: { width: 56, height: 41, marginRight: 10 },
  companyWrap: { flex: 1, alignItems: "center" },
  company: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  meta: { width: 225, paddingVertical: 12, paddingRight: 12 },
  metaRow: { flexDirection: "row", marginBottom: 4 },
  metaK: { width: 78 },
  metaV: { flex: 1 },

  // to
  toRow: { flexDirection: "row", minHeight: 95, borderBottomWidth: 1, borderColor: BLACK, padding: 10 },
  toLabel: { width: 34 },
  clientName: { fontSize: 12, fontFamily: "Helvetica-Bold", marginBottom: 3 },
  clientLine: { marginBottom: 1 },

  // salesperson grid
  spHeaderRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: BLACK },
  spValuesRow: { flexDirection: "row", borderBottomWidth: 1, borderColor: BLACK, minHeight: 18 },
  spCell: { flex: 1, paddingVertical: 4, paddingHorizontal: 6, borderRightWidth: 1, borderColor: BLACK },
  spCellLast: { flex: 1, paddingVertical: 4, paddingHorizontal: 6 },
  spLabel: { fontSize: 8.5 },

  // items
  itemsWrap: { minHeight: 290, flexDirection: "column" },
  row: { flexDirection: "row" },
  cQty: { width: 72, paddingVertical: 4, paddingHorizontal: 10, textAlign: "right" },
  cDesc: { flex: 1, paddingVertical: 4, paddingHorizontal: 10 },
  cPrice: { width: 95, paddingVertical: 4, paddingHorizontal: 10, textAlign: "right" },
  cTotal: { width: 110, paddingVertical: 4, paddingHorizontal: 10, textAlign: "right", backgroundColor: GRAY },
  hLabel: { fontFamily: "Helvetica-Bold" },
  filler: { flexGrow: 1, flexDirection: "row" },
  fillerLeft: { flex: 1 },
  fillerTotal: { width: 110, backgroundColor: GRAY },

  // totals
  totals: { flexDirection: "row", borderTopWidth: 1, borderColor: BLACK },
  piezas: { flex: 1, flexDirection: "row", padding: 10, alignItems: "center" },
  piezasVal: { fontFamily: "Helvetica-Bold", fontSize: 11, marginLeft: 12 },
  totLabels: { width: 110 },
  totLabel: { textAlign: "right", paddingHorizontal: 8, paddingVertical: 3.5 },
  totAmounts: { width: 110, backgroundColor: GRAY },
  totAmt: { textAlign: "right", paddingHorizontal: 10, paddingVertical: 3.5 },

  // shipping box
  shipWrap: { padding: 10 },
  shipBox: { borderWidth: 2, borderColor: BLACK, minHeight: 88, padding: 8 },
  shipTitle: { fontFamily: "Helvetica-Bold", marginBottom: 4 },
  shipLine: { flexDirection: "row", marginBottom: 2 },
  shipK: { width: 70, fontFamily: "Helvetica-Bold" },
  shipV: { flex: 1, fontFamily: "Helvetica-Bold" },

  footer: { textAlign: "center", fontSize: 11, color: "#333", marginTop: 12 },
});

// Una página (factura o remito). Se reusa para el remito por proveedor.
function InvoicePage({ company, client, order, mode }) {
  const remito = mode === "remito";
  const items = order.items || [];
  const totalPiezas = items.reduce((a, i) => a + (Number(i.qty) || 0), 0);
  const subtotal = items.reduce((a, i) => a + (Number(i.qty) || 0) * (Number(i.price) || 0), 0);
  const shipping = Number(order.shippingCost) || 0;
  const total = subtotal + shipping;
  const hasShip = client.notify || client.direccion || client.telefono || client.contacto;
  const meta = remito
    ? [
        ["Proveedor:", client.name],
        ["Remito Fact. #:", order.invoiceNo],
        ["Date:", order.date],
        ["FOB:", order.fob],
      ]
    : [
        ["Date:", order.date],
        ["Invoice #:", order.invoiceNo],
        ["Payment:", order.payment],
        ["FOB:", order.fob],
      ];

  return (
      <Page size="LETTER" style={s.page}>
        <View style={s.outer}>
          {/* header */}
          <View style={s.header}>
            <View style={s.headerLeft}>
              <Image src={LOGO} style={s.logo} />
              <View style={s.companyWrap}>
                <Text style={s.company}>{company.name}</Text>
              </View>
            </View>
            <View style={s.meta}>
              {meta.map(([k, v]) => (
                <View style={s.metaRow} key={k}>
                  <Text style={s.metaK}>{k}</Text>
                  <Text style={s.metaV}>{v}</Text>
                </View>
              ))}
            </View>
          </View>

          {/* to */}
          <View style={s.toRow}>
            <Text style={s.toLabel}>{remito ? "Prov.:" : "To:"}</Text>
            <View>
              <Text style={s.clientName}>{client.name}</Text>
              {(client.addressLines || []).map((l, i) => <Text style={s.clientLine} key={i}>{l}</Text>)}
              {client.ruc ? <Text style={s.clientLine}>RUC: {client.ruc}</Text> : null}
              {client.phone ? <Text style={s.clientLine}>Telefono: {client.phone}</Text> : null}
            </View>
          </View>

          {/* salesperson grid */}
          <View style={s.spHeaderRow}>
            <Text style={[s.spCell, s.spLabel]}>Salesperson</Text>
            <Text style={[s.spCell, s.spLabel]}>Job</Text>
            <Text style={[s.spCell, s.spLabel]}>Payment Terms</Text>
            <Text style={[s.spCellLast, s.spLabel]}>Due Date</Text>
          </View>
          <View style={s.spValuesRow}>
            <Text style={s.spCell}>{order.salesperson}</Text>
            <Text style={s.spCell}>{order.job || ""}</Text>
            <Text style={s.spCell}>{order.terms}</Text>
            <Text style={s.spCellLast}>{order.dueDate}</Text>
          </View>

          {/* items */}
          <View style={s.itemsWrap}>
            <View style={s.row}>
              <Text style={s.cQty}></Text>
              <Text style={[s.cDesc, s.hLabel]}>Description</Text>
              {!remito && <Text style={s.cPrice}></Text>}
              {!remito && <Text style={[s.cTotal, s.hLabel]}>Line Total</Text>}
            </View>
            {items.map((it, idx) => (
              <View style={s.row} key={idx}>
                <Text style={s.cQty}>{it.qty}</Text>
                <Text style={s.cDesc}>{itemDesc(it)}</Text>
                {!remito && <Text style={s.cPrice}>{money(it.price)}</Text>}
                {!remito && <Text style={s.cTotal}>{money((Number(it.qty) || 0) * (Number(it.price) || 0))}</Text>}
              </View>
            ))}
            {/* filler to keep the form tall + extend the gray band */}
            <View style={s.filler}>
              <View style={s.fillerLeft} />
              {!remito && <View style={s.fillerTotal} />}
            </View>
          </View>

          {/* totals */}
          <View style={s.totals}>
            <View style={s.piezas}>
              <Text>Total Piezas:</Text>
              <Text style={s.piezasVal}>{totalPiezas}</Text>
            </View>
            {!remito && (
              <>
                <View style={s.totLabels}>
                  <Text style={s.totLabel}>Subtotal</Text>
                  <Text style={s.totLabel}>Shipping</Text>
                  <Text style={[s.totLabel, s.hLabel]}>Total</Text>
                </View>
                <View style={s.totAmounts}>
                  <Text style={s.totAmt}>{money(subtotal)}</Text>
                  <Text style={s.totAmt}>{shipping ? money(shipping) : " "}</Text>
                  <Text style={[s.totAmt, s.hLabel]}>{money(total)}</Text>
                </View>
              </>
            )}
          </View>

          {/* shipping box */}
          <View style={s.shipWrap}>
            <View style={s.shipBox}>
              <Text style={s.shipTitle}>Shipping:</Text>
              {hasShip && (
                <View>
                  {client.notify ? <View style={s.shipLine}><Text style={s.shipK}>Notify:</Text><Text style={s.shipV}>{client.notify}</Text></View> : null}
                  {client.direccion ? <View style={s.shipLine}><Text style={s.shipK}>Direccion:</Text><Text style={s.shipV}>{client.direccion}</Text></View> : null}
                  {client.telefono ? <View style={s.shipLine}><Text style={s.shipK}>Telefono:</Text><Text style={s.shipV}>{client.telefono}</Text></View> : null}
                  {client.contacto ? <View style={s.shipLine}><Text style={s.shipK}>Contacto:</Text><Text style={s.shipV}>{client.contacto}</Text></View> : null}
                </View>
              )}
            </View>
          </View>
        </View>

        <Text style={s.footer}>Thank you for your business!</Text>
      </Page>
  );
}

// Factura / remito normal (al cliente): un documento de una página.
export default function InvoiceDoc({ company, client, order, mode }) {
  return (
    <Document>
      <InvoicePage company={company} client={client} order={order} mode={mode} />
    </Document>
  );
}

// Remitos por proveedor: un documento con una página por proveedor, sin precios.
// groups: [{ supplier, client, order }] — order.items son solo las líneas de ese proveedor.
export function RemitosDoc({ company, groups }) {
  return (
    <Document>
      {groups.map((g, i) => (
        <InvoicePage key={i} company={company} client={g.client} order={g.order} mode="remito" />
      ))}
    </Document>
  );
}
