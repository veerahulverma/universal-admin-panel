import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { money, toMinor } from '../../lib/format';
import { Button, Checkbox, Field, FormError, Input, Modal, Select, Textarea } from '../../components/ui';
import { AmountInput, CustomerPicker, subjectBody, useCurrencies, type PickedCustomer } from './shared';
import { FollowUpFields, OutcomeModal, useFollowUp, type CreatedInvoice, type FollowUpOption, type Outcome } from './invoice-follow-up';

interface LineDraft {
  key: number;
  description: string;
  quantity: string;
  unitPrice: string;
  taxInclusive: boolean;
}

const FOLLOW_UPS: FollowUpOption[] = [
  { value: 'email', label: 'Issue and email it', description: 'The customer gets the invoice with a secure link to pay online.', submit: 'Issue and send' },
  { value: 'link', label: 'Issue and create a payment link', description: 'A hosted checkout on the gateway you choose, for you to share.', submit: 'Issue and create link' },
  { value: 'paid', label: 'Issue and record a payment', description: 'For money already received offline (bank transfer, cash, cheque). The invoice is marked paid.', submit: 'Issue and record payment' },
  { value: 'pending', label: 'Issue as pending', description: 'Open and unpaid; collect payment later from the invoice.', submit: 'Issue invoice' },
  { value: 'draft', label: 'Save as draft', description: 'Not numbered or visible to the customer until finalized.', submit: 'Save draft' },
];

/** The manual invoice form: free-text lines for one-off work or charges. */
export function CreateInvoiceDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone?: (invoice: CreatedInvoice) => void }) {
  const { base, list } = useCurrencies();
  const [customer, setCustomer] = useState<PickedCustomer | null>(null);
  const [currency, setCurrency] = useState(base);
  const [lines, setLines] = useState<LineDraft[]>([{ key: 1, description: '', quantity: '1', unitPrice: '', taxInclusive: false }]);
  const [dueDays, setDueDays] = useState('14');
  const [notes, setNotes] = useState('');
  const follow = useFollowUp('email');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const subtotal = lines.reduce((sum, l) => sum + (toMinor(l.unitPrice || '0', currency) ?? 0) * (Number(l.quantity) || 0), 0);
  const update = (key: number, patch: Partial<LineDraft>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const option = FOLLOW_UPS.find((f) => f.value === follow.followUp)!;
  const finish = (invoice: CreatedInvoice) => {
    onOpenChange(false);
    onDone?.(invoice);
  };

  const create = useAction(
    async (): Promise<Outcome> => {
      if (!customer) throw new Error('Choose the customer to bill');
      const body = lines.map((l, i) => {
        const unitAmount = toMinor(l.unitPrice, currency);
        if (!l.description.trim()) throw new Error(`Line ${i + 1}: add a description`);
        if (unitAmount === null || l.unitPrice.trim() === '') throw new Error(`Line ${i + 1}: enter a unit price`);
        return { description: l.description.trim(), quantity: Math.max(1, Math.round(Number(l.quantity) || 1)), unitAmount, taxInclusive: l.taxInclusive };
      });
      const invoice = await api.post<CreatedInvoice>('/api/admin/invoices', {
        ...subjectBody(customer),
        currency,
        lines: body,
        dueDays: Number(dueDays) || 0,
        notes: notes.trim() || undefined,
        draft: follow.followUp === 'draft',
        sendEmail: follow.followUp === 'email',
      });
      return follow.run(invoice);
    },
    {
      success: ({ invoice, problem }) => {
        if (problem) return null;
        if (invoice.status === 'draft') return 'Draft invoice saved';
        if (follow.followUp === 'paid') return `Invoice ${invoice.number ?? ''} issued and marked paid`;
        return `Invoice ${invoice.number ?? ''} issued`;
      },
      invalidate: [['invoices']],
      onSuccess: (result) => (result.url || result.problem ? setOutcome(result) : finish(result.invoice)),
      onError: (e) => setError(errorMessage(e)),
    },
  );

  if (outcome) return <OutcomeModal open={open} onOpenChange={onOpenChange} outcome={outcome} followUp={follow.followUp} onDone={() => finish(outcome.invoice)} />;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New invoice"
      description="Bill a customer for one-off work or charges. Tax is calculated from the customer's billing details when tax is enabled."
      size="xl"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="create-invoice" loading={create.isPending} disabled={!customer}>
            {option.submit}
          </Button>
        </>
      }
    >
      <form
        id="create-invoice"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          create.mutate();
        }}
      >
        <FormError message={error} />
        <div className="grid gap-4 md:grid-cols-[1fr_12rem]">
          <Field label="Bill to" required>
            <CustomerPicker value={customer} onChange={setCustomer} />
          </Field>
          <div className="space-y-3">
            <Field label="Currency" htmlFor="ni-currency">
              <Select id="ni-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} options={list} />
            </Field>
            <Field label="Payment due in (days)" htmlFor="ni-due">
              <Input id="ni-due" type="number" min={0} max={365} step={1} value={dueDays} onChange={(e) => setDueDays(e.target.value)} />
            </Field>
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Line items</legend>
          <div className="hidden grid-cols-[1fr_5rem_9rem_6.5rem_2.25rem] gap-2 px-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid">
            <span>Description</span>
            <span>Qty</span>
            <span>Unit price</span>
            <span>Tax incl.</span>
            <span className="sr-only">Remove</span>
          </div>
          {lines.map((l, i) => (
            <div key={l.key} className="grid grid-cols-2 items-center gap-2 rounded-ui-sm border p-2 md:grid-cols-[1fr_5rem_9rem_6.5rem_2.25rem] md:border-0 md:p-0">
              <Input aria-label={`Line ${i + 1} description`} placeholder="e.g. Onboarding workshop" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} className="col-span-2 md:col-span-1" maxLength={500} />
              <Input aria-label={`Line ${i + 1} quantity`} type="number" min={1} step={1} value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} />
              <AmountInput value={l.unitPrice} onChange={(v) => update(l.key, { unitPrice: v })} currency={currency} label={`Line ${i + 1} unit price`} />
              <Checkbox checked={l.taxInclusive} onChange={(e) => update(l.key, { taxInclusive: e.target.checked })} label={<span className="md:sr-only">Price includes tax</span>} aria-label={`Line ${i + 1} price includes tax`} />
              <Button variant="ghost" size="icon-sm" aria-label={`Remove line ${i + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} className="justify-self-end">
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button variant="outline" size="sm" icon={<Plus className="size-3.5" />} onClick={() => setLines((ls) => [...ls, { key: Date.now(), description: '', quantity: '1', unitPrice: '', taxInclusive: false }])} disabled={lines.length >= 100}>
              Add line
            </Button>
            <p className="text-sm">
              Subtotal <span className="font-semibold tabular">{money(subtotal, currency)}</span>
              <span className="text-muted-foreground"> before tax</span>
            </p>
          </div>
        </fieldset>

        <Field label="Notes" htmlFor="ni-notes" hint="Printed on the invoice">
          <Textarea id="ni-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </Field>
        <FollowUpFields id="ni" options={FOLLOW_UPS} state={follow} />
      </form>
    </Modal>
  );
}
