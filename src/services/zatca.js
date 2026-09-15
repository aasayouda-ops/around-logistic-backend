// ── ZATCA E-Invoicing Service ─────────────────────────────────
// Phase 1: QR Code (implemented)
// Phase 2: XML signed invoice (structure ready, signing requires ZATCA cert)

// ── TLV encoder for ZATCA QR ─────────────────────────────────
function tlvEncode(tag, value) {
  const valBytes = Buffer.from(value, 'utf8');
  const buf = Buffer.alloc(2 + valBytes.length);
  buf[0] = tag;
  buf[1] = valBytes.length;
  valBytes.copy(buf, 2);
  return buf;
}

// ── Build ZATCA Phase 1 QR payload ───────────────────────────
export function buildZatcaQR({ sellerName, vatNumber, timestamp, total, vatAmount }) {
  const parts = [
    tlvEncode(1, sellerName),
    tlvEncode(2, vatNumber),
    tlvEncode(3, timestamp),
    tlvEncode(4, Number(total).toFixed(2)),
    tlvEncode(5, Number(vatAmount).toFixed(2))
  ];
  return Buffer.concat(parts).toString('base64');
}

// ── Build ZATCA Phase 2 XML invoice (unsigned — signing needs ZATCA cert) ──
export function buildZatcaXML({
  invoiceNumber, issueDate, issueTime,
  sellerName, vatNumber, crNumber,
  buyerName,
  lineItems,
  subtotal, vatAmount, total
}) {
  const lines = lineItems.map((item, i) => `
    <cac:InvoiceLine>
      <cbc:ID>${i + 1}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="PCE">${item.qty}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="SAR">${item.amount.toFixed(2)}</cbc:LineExtensionAmount>
      <cac:Item>
        <cbc:Name>${item.name}</cbc:Name>
        <cac:ClassifiedTaxCategory>
          <cbc:ID>S</cbc:ID>
          <cbc:Percent>15</cbc:Percent>
        </cac:ClassifiedTaxCategory>
      </cac:Item>
      <cac:Price>
        <cbc:PriceAmount currencyID="SAR">${item.unitPrice.toFixed(2)}</cbc:PriceAmount>
      </cac:Price>
    </cac:InvoiceLine>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${invoiceNumber}</cbc:ID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification>
        <cbc:ID schemeID="CRN">${crNumber}</cbc:ID>
      </cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${sellerName}</cbc:Name></cac:PartyName>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>${vatNumber}</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyName><cbc:Name>${buyerName}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${vatAmount.toFixed(2)}</cbc:TaxAmount>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${subtotal.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${total.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="SAR">${total.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  ${lines}
</Invoice>`;
}

// ── Generate full invoice data for a delivered shipment ───────
export function generateInvoice(shipment, store) {
  const now   = new Date(shipment.delivered_at || Date.now());
  const qr    = buildZatcaQR({
    sellerName: store.store_name,
    vatNumber:  store.vat_number,
    timestamp:  now.toISOString(),
    total:      shipment.price_total,
    vatAmount:  shipment.vat_amount
  });
  const xml   = buildZatcaXML({
    invoiceNumber: shipment.invoice_number,
    issueDate:     now.toISOString().split('T')[0],
    issueTime:     now.toTimeString().split(' ')[0],
    sellerName:    store.store_name,
    vatNumber:     store.vat_number,
    crNumber:      store.cr_number,
    buyerName:     'عميل',
    lineItems:     [{ name: shipment.product_name, qty: 1,
                      unitPrice: shipment.price_subtotal, amount: shipment.price_subtotal }],
    subtotal:      Number(shipment.price_subtotal),
    vatAmount:     Number(shipment.vat_amount),
    total:         Number(shipment.price_total)
  });
  return { qr, xml };
}
