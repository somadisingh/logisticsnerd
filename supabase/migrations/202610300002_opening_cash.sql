SET search_path TO logistics, public;

-- Opening cash: one supplier-less ledger entry, recorded once, in the money currency.
ALTER TABLE money_ledger ALTER COLUMN supplier_id DROP NOT NULL;
ALTER TABLE money_ledger DROP CONSTRAINT money_ledger_entry_type_check;
ALTER TABLE money_ledger ADD CONSTRAINT money_ledger_entry_type_check
 CHECK(entry_type IN ('supplier_charge','supplier_payment','opening_cash'));
ALTER TABLE money_ledger ADD CONSTRAINT money_ledger_supplier_check
 CHECK((entry_type='opening_cash')=(supplier_id IS NULL));
CREATE UNIQUE INDEX money_ledger_one_opening ON money_ledger((true)) WHERE entry_type='opening_cash';

CREATE OR REPLACE FUNCTION guard_money_entry() RETURNS trigger LANGUAGE plpgsql SET search_path=logistics,pg_temp AS $$
DECLARE expected text; p purchase_order_lines%ROWTYPE; po purchase_orders%ROWTYPE; rl receipt_lines%ROWTYPE;
 rc receipts%ROWTYPE; pay supplier_payments%ROWTYPE; line_total numeric; line_quantity numeric;
 received bigint; charged bigint; owed bigint;
BEGIN
 PERFORM pg_advisory_xact_lock(1768842364,0);
 expected:=money_currency();
 IF expected IS NOT NULL AND NEW.currency<>expected THEN RAISE EXCEPTION 'money currency must match the business currency' USING ERRCODE='23514'; END IF;
 IF NEW.entry_type='supplier_charge' THEN
  SELECT * INTO p FROM purchase_order_lines WHERE id=NEW.po_line_id FOR UPDATE;
  SELECT * INTO po FROM purchase_orders WHERE id=p.purchase_order_id;
  SELECT * INTO rl FROM receipt_lines WHERE id=NEW.receipt_line_id;
  SELECT * INTO rc FROM receipts WHERE id=rl.receipt_id;
  IF rl.po_line_id IS DISTINCT FROM NEW.po_line_id OR po.status<>'approved' OR po.supplier_id<>NEW.supplier_id
   OR po.currency<>NEW.currency OR rc.request_key<>NEW.request_key OR rc.received_on<>NEW.occurred_on THEN
   RAISE EXCEPTION 'supplier charge must match its approved purchase line and receipt' USING ERRCODE='23514';
  END IF;
  line_total:=(p.approved_terms->>'total_minor')::numeric;
  line_quantity:=(p.approved_terms->>'quantity')::numeric;
  IF line_total IS NULL OR line_quantity IS DISTINCT FROM p.quantity THEN RAISE EXCEPTION 'purchase line has no frozen approved total' USING ERRCODE='23514'; END IF;
  -- Cumulative rounding: partial charges always sum exactly to the frozen line total.
  SELECT COALESCE(sum(quantity),0)::bigint INTO received FROM receipt_lines WHERE po_line_id=NEW.po_line_id AND id<=NEW.receipt_line_id;
  SELECT COALESCE(sum(amount_minor),0)::bigint INTO charged FROM money_ledger WHERE po_line_id=NEW.po_line_id;
  IF NEW.amount_minor<>floor(line_total*received/line_quantity)::bigint-charged THEN RAISE EXCEPTION 'supplier charge must follow the approved line total' USING ERRCODE='23514'; END IF;
 ELSIF NEW.entry_type='supplier_payment' THEN
  SELECT * INTO pay FROM supplier_payments WHERE id=NEW.payment_id;
  IF (pay.supplier_id,pay.amount_minor,pay.currency,pay.paid_on,pay.request_key) IS DISTINCT FROM
     (NEW.supplier_id,NEW.amount_minor,NEW.currency,NEW.occurred_on,NEW.request_key) THEN
   RAISE EXCEPTION 'ledger payment must match its payment record' USING ERRCODE='23514';
  END IF;
  -- Supplier revisions share an external key; the account follows the supplier, not the revision.
  SELECT COALESCE(sum(CASE WHEN m.entry_type='supplier_charge' THEN m.amount_minor ELSE -m.amount_minor END),0)::bigint INTO owed
   FROM money_ledger m JOIN core_bindings b ON b.id=m.supplier_id
   WHERE b.kind='supplier' AND b.external_key=(SELECT external_key FROM core_bindings WHERE id=NEW.supplier_id);
  IF NEW.amount_minor>owed THEN RAISE EXCEPTION 'payment exceeds the amount owed to the supplier' USING ERRCODE='23514'; END IF;
 ELSE
  -- Opening cash cannot choose the currency: it needs business setup or earlier money.
  IF expected IS NULL THEN RAISE EXCEPTION 'opening cash requires a known business currency' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
