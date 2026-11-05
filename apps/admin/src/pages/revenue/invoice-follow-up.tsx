import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api, errorMessage } from '../../lib/api';
import { Button, ButtonLink, Callout, CodeBlock, Field, Input, Modal, Select, buttonClass } from '../../components/ui';
import { useGateways } from './shared';

export interface CreatedInvoice {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  amount_due: number;
  amount_paid: number;
}

/** What happens once an invoice is saved. Every step after creating it is an existing invoice action. */
export type FollowUp = 'email' | 'link' | 'paid' | 'pending' | 'draft';

export interface FollowUpOption {
  value: FollowUp;
  label: string;
  description: string;
  /** Label of the form's submit button for this choice. */
  submit: string;
}

export interface Outcome {
  invoice: CreatedInvoice;
  url?: string;
  /** A follow-up step that failed after the invoice was saved. */
  problem?: string;
}

export function useFollowUp(initial: FollowUp) {
  const [followUp, setFollowUp] = useState<FollowUp>(initial);
  const [gatewayId, setGatewayId] = useState('');
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  /**
   * Runs the chosen step for a saved invoice. The invoice exists by now, so a failure is
   * reported instead of thrown: submitting the form again would bill the customer twice.
   */
  const run = async (invoice: CreatedInvoice): Promise<Outcome> => {
    // Drafts, and invoices already settled by discounts or account credit, have nothing to collect.
    if (invoice.status !== 'open') return { invoice };
    try {
      if (followUp === 'paid') await api.post(`/api/admin/invoices/${invoice.id}/mark-paid`, { method, reference: reference.trim() || undefined });
      if (followUp === 'link') {
        const checkout = await api.post<{ id: string; url: string }>(`/api/admin/invoices/${invoice.id}/checkout`, { gatewayId: gatewayId || undefined });
        return { invoice, url: checkout.url };
      }
      return { invoice };
    } catch (e) {
      return { invoice, problem: errorMessage(e) };
    }
  };
  return { followUp, setFollowUp, gatewayId, setGatewayId, method, setMethod, reference, setReference, run };
}

export type FollowUpState = ReturnType<typeof useFollowUp>;

/** The "After saving" choice, plus the gateway or payment details the choice needs. */
export function FollowUpFields({ id, options, state }: { id: string; options: FollowUpOption[]; state: FollowUpState }) {
  const gateways = useGateways();
  const gatewayOptions = (gateways.data?.data ?? []).filter((g) => g.enabled).map((g) => ({ value: g.id, label: `${g.name}${g.mode === 'test' ? ' (test)' : ''}` }));
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">After saving</legend>
        <div className="grid gap-2 md:grid-cols-2">
          {options.map((f) => (
            <label key={f.value} className="flex cursor-pointer items-start gap-2.5 rounded-ui-sm border p-3 text-sm has-[:checked]:border-primary">
              <input type="radio" name={`${id}-follow-up`} className="mt-0.5 accent-[var(--color-primary)]" checked={state.followUp === f.value} onChange={() => state.setFollowUp(f.value)} />
              <span>
                <span className="font-medium">{f.label}</span>
                <span className="block text-sm text-muted-foreground">{f.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {state.followUp === 'link' && (
        <Field label="Gateway" htmlFor={`${id}-gateway`} hint="Leave on default to use the best gateway for this currency.">
          <Select id={`${id}-gateway`} value={state.gatewayId} onChange={(e) => state.setGatewayId(e.target.value)} placeholder="Default for the currency" options={gatewayOptions} />
        </Field>
      )}
      {state.followUp === 'paid' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Payment method" htmlFor={`${id}-method`} hint="The full invoice total, including tax, is recorded as received.">
            <Select
              id={`${id}-method`}
              value={state.method}
              onChange={(e) => state.setMethod(e.target.value)}
              options={[
                { value: 'bank_transfer', label: 'Bank transfer' },
                { value: 'cash', label: 'Cash' },
                { value: 'check', label: 'Cheque' },
                { value: 'other', label: 'Other' },
              ]}
            />
          </Field>
          <Field label="Reference" htmlFor={`${id}-reference`} hint="Bank reference or receipt number">
            <Input id={`${id}-reference`} value={state.reference} onChange={(e) => state.setReference(e.target.value)} maxLength={200} />
          </Field>
        </div>
      )}
    </>
  );
}

/** Shown after saving when there is a payment link to share, or a follow-up step failed. */
export function OutcomeModal({ open, onOpenChange, outcome, followUp, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; outcome: Outcome; followUp: FollowUp; onDone: () => void }) {
  const { invoice, url, problem } = outcome;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Invoice ${invoice.number ?? ''} issued`}
      size="lg"
      footer={
        <>
          <ButtonLink to={`/revenue/invoices/${invoice.id}`}>View invoice</ButtonLink>
          <Button onClick={onDone}>Done</Button>
        </>
      }
    >
      {problem ? (
        <Callout tone="warning" title={followUp === 'paid' ? 'The payment was not recorded' : 'The payment link was not created'}>
          {problem} The invoice is open; finish this step from the invoice page.
        </Callout>
      ) : (
        url && (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">Share this link with the customer. The invoice is settled when the payment succeeds.</p>
            <CodeBlock code={url} />
            <a href={url} target="_blank" rel="noreferrer" className={buttonClass('outline')}>
              <ExternalLink className="size-4" /> Open checkout
            </a>
          </div>
        )
      )}
    </Modal>
  );
}
