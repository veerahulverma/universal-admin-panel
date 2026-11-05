import { useAuth } from '../src/auth/AuthContext';
import { ErrorBox, Loading, Screen } from '../src/ui/components';

/** Entry point; the root layout redirects once the session state is known. */
export default function Index() {
  const { status, error, retry, signOut } = useAuth();
  if (status === 'error') {
    return (
      <Screen>
        <ErrorBox message={`${error ?? 'Could not reach the server.'} Check your connection.`} onRetry={() => void retry()} />
        <ErrorBox message="Or sign out and connect to a different server." onRetry={() => void signOut()} />
      </Screen>
    );
  }
  return <Loading />;
}
