import ErrorBoundary from "./components/ErrorBoundary";
import { LanguageProvider } from "./contexts/LanguageContext";
import Home from "./pages/Home";

function App() {
  return (
    <ErrorBoundary>
      <LanguageProvider>
        <Home />
      </LanguageProvider>
    </ErrorBoundary>
  );
}

export default App;
