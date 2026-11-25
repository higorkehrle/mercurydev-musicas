import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource/instrument-serif/latin-400-italic.css';
import './styles.css';
import { App } from './App.tsx';
import { I18nProvider, bootI18n } from './i18n/i18n.tsx';

// The saved language's dictionary loads before the first render: nothing flashes in pt-BR.
void bootI18n().then((lang) => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <I18nProvider initialLang={lang}>
        <App />
      </I18nProvider>
    </StrictMode>,
  );
});
