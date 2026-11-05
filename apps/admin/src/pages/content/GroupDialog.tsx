import { useState } from 'react';
import { api, ApiError, errorMessage } from '../../lib/api';
import { useAction } from '../../lib/mutations';
import { Badge, Button, Checkbox, Field, FormError, Input, Modal, Skeleton, Textarea } from '../../components/ui';
import { ProductKindLabel, useGroupProductOptions, type UserGroup } from './shared';

/** Create a group, or rename it and change its automatic membership. */
export function GroupDialog({ group, onClose, onSaved }: { group: UserGroup | null; onClose: () => void; onSaved?: (group: UserGroup) => void }) {
  const [name, setName] = useState(group?.name ?? '');
  const [description, setDescription] = useState(group?.description ?? '');
  const [productIds, setProductIds] = useState<string[]>(group?.autoProducts.map((p) => p.id) ?? []);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const options = useGroupProductOptions();
  const products = (options.data?.products ?? []).filter((p) => p.status !== 'archived' || productIds.includes(p.id));
  const plans = products.filter((p) => p.kind === 'plan');
  const others = products.filter((p) => p.kind !== 'plan');

  const save = useAction(
    () => {
      const body = { name, description, autoProductIds: productIds };
      return group ? api.patch<UserGroup>(`/api/admin/user-groups/${group.id}`, body) : api.post<UserGroup>('/api/admin/user-groups', body);
    },
    {
      success: group ? 'Group saved' : 'Group created',
      invalidate: [['user-groups'], ['user-group'], ['user-group-members']],
      onSuccess: (saved) => {
        onClose();
        onSaved?.(saved);
      },
      onError: (e) => {
        setError(errorMessage(e));
        if (e instanceof ApiError) setFieldErrors(e.fieldErrors());
      },
    },
  );

  const toggle = (id: string, on: boolean) => setProductIds((ids) => (on ? [...ids, id] : ids.filter((x) => x !== id)));
  const productList = (title: string, list: typeof products) =>
    list.length > 0 && (
      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
        <div className="space-y-2">
          {list.map((p) => (
            <Checkbox
              key={p.id}
              checked={productIds.includes(p.id)}
              onChange={(e) => toggle(p.id, e.target.checked)}
              label={
                <span className="inline-flex flex-wrap items-center gap-1.5">
                  {p.name}
                  <span className="font-mono text-xs font-normal text-muted-foreground">{p.key}</span>
                  {p.status !== 'active' && <Badge>{p.status}</Badge>}
                </span>
              }
              description={<ProductKindLabel kind={p.kind} />}
            />
          ))}
        </div>
      </div>
    );

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={group ? `Edit ${group.name}` : 'New user group'}
      description="Groups collect customers so content rules can name them together."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="group-form" loading={save.isPending}>
            {group ? 'Save' : 'Create group'}
          </Button>
        </>
      }
    >
      <form
        id="group-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          save.mutate();
        }}
      >
        <FormError message={error} />
        <Field label="Name" htmlFor="group-name" error={fieldErrors.name} required>
          <Input id="group-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required autoFocus placeholder="Beta testers" />
        </Field>
        <Field label="Description" htmlFor="group-description" error={fieldErrors.description}>
          <Textarea id="group-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} />
        </Field>
        <Field
          label="Automatic membership"
          error={fieldErrors.autoProductIds}
          hint="Customers belong to the group while they, or an organization they are a member of, have an active subscription to or a grant of one of these products. Membership ends with the subscription or grant."
        >
          <div className="max-h-64 space-y-4 overflow-y-auto rounded-ui-sm border p-3">
            {options.isLoading ? (
              <Skeleton className="h-20" />
            ) : options.error ? (
              <p className="text-sm text-danger">{errorMessage(options.error)}</p>
            ) : products.length === 0 ? (
              <p className="text-sm text-muted-foreground">No products yet. Members can still be added by hand.</p>
            ) : (
              <>
                {productList('Plans', plans)}
                {productList('Add-ons and other products', others)}
              </>
            )}
          </div>
        </Field>
      </form>
    </Modal>
  );
}
