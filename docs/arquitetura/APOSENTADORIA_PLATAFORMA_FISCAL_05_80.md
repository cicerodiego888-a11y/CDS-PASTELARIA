# Aposentadoria da interface “Plataforma Fiscal” (05.80)

## 1. Situação anterior

O Centro de Configurações expunha a aba **Plataforma Fiscal**, um formulário global (`carregarFiscalConfig` → `GET/PUT /api/fiscal/config` → `configuracoes.fiscal_*`) paralelo à configuração por `empresa_id` em **Empresas**.

## 2. Tela aposentada

Aba **Plataforma Fiscal** do Centro de Configurações (ambiente, UF, série, NFC-e, CRT, endereço, certificado global, etc.).

## 3. Localização

`frontend/erp/js/cds-centro-configuracoes.js` — categoria `plataformaFiscal` e pane `data-cfg-pane="plataformaFiscal"`.

## 4–5. Fonte oficial

**Empresas** → editar empresa → **Configuração Fiscal** + **Certificado Digital** (`empresas_configuracao_fiscal` / `empresa_id`). UI: `frontend/erp/js/gestao-empresas-fiscal.js`.

## 6. APIs preservadas

`GET /api/fiscal/config` e `PUT /api/fiscal/config` permanecem (consumidores internos, p.ex. painel executivo do Centro).

## 7. Backend global preservado

`configuracoes.fiscal_*` e `getFiscalConfig()` sem `empresaId` continuam como compatibilidade interna.

## 8. fiscal.js

Arquivo **não** removido. NFC-e (lista, emitir, consultar, cancelar, detalhe) preservada. O aviso da tela NFC-e aponta para **Empresas**, não para a aba aposentada. `carregarFiscalConfig` permanece no arquivo; o container da aba antiga não é mais montado.

## 9. NFC-e

Menu **NFC-e Emitidas** (`data-page="fiscal"`) e `loadFiscal()` intactos.

## 10. Impactos

- Menu do Centro: categoria removida.
- Deep-link da Central (`__CDS_CFG_FORCE_TAB=fiscal` + âncora `manifestacao`): card de **Manifestação do Destinatário** movido para **Diagnóstico** (não é configuração fiscal global).
- Botão de Diagnóstico abre **Empresas**.
- Central de Entradas, DistDFe, PDV, schema e motor fiscal: não alterados nesta sprint.

## 11. Testes

`tests/fiscal/aposentadoria-plataforma-fiscal-05-80.test.js` (T01–T12).

## 12. Regressões

05.76–05.78, 03.01–03.05, sprint 3.9 do Centro, RC4.3 Manifestação.

## 13. Referências restantes legítimas

- Central (`plataformaFiscal` no painel, tooltips Registry/UrlResolver): motor de transporte SEFAZ, não a aba.
- Splash `login-experience.js` / `intro.js`: texto legado de boot.
- Comentários em `backend/services/fiscal/**` e `FISCAL_PLATFORM.md`: arquitetura do motor.
- Docs históricas 05.18 / 05.46.
- Alias `plataformaFiscal` → `empresa` no Centro: aba morta não reabre o formulário global.
- Pane oculta `plataformaFiscalRuntime`: `aria-hidden`, sem item de menu.
- `tests/fiscal/fiscal-platform.test.js`: suíte do motor.
