import { ErrorBoundary } from './components/ErrorBoundary';
import { AppRoutes } from './routes';

export function App() {
  return (
    <ErrorBoundary>
      <AppRoutes />
    </ErrorBoundary>
  );
}
