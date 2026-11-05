import { Compass } from 'lucide-react';
import { ButtonLink, EmptyState } from '../components/ui';
import { pageTitle } from '../lib/theme';

export default function NotFoundPage() {
  pageTitle('Not found');
  return (
    <EmptyState
      icon={<Compass />}
      title="Page not found"
      description="This page does not exist, or the module that provides it is turned off."
      action={
        <ButtonLink to="/" variant="outline">
          Go to the dashboard
        </ButtonLink>
      }
    />
  );
}
