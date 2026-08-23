# Relatório — Sprint 05.18.2

Completar URLs fiscais na Configuração Fiscal por empresa.

## ESTADO

**ESTADO B — IMPLEMENTAÇÃO TÉCNICA CONCLUÍDA — VALIDAÇÃO VISUAL PENDENTE**

Não declarar a sprint 100% concluída sem abrir o ERP e gravar as URLs nas duas empresas.

## URLs encontradas no Motor Fiscal

**Contrato (configuráveis, agora na tela Empresas):**

- URL Consulta QRCode (homologação e produção)
- URL Consulta Chave (homologação e produção)
- WS Autorização (homologação e produção)
- WS Retorno (homologação e produção)
- WS Status (homologação e produção)

Uso: `getFiscalConfig` → `config.urls` → `emissor.js` (autorização, QR, chave). Retorno e status estão no contrato e na UI; o emissor ainda não os consome.

**Catálogo RegistryBuilder (não gravados por empresa):** cancelamento/evento, consulta protocolo, DF-e, manifestação, autorização NF-e/NFC-e da plataforma.

**Inexistentes no motor:** inutilização (só enum), consulta cadastro. Sem campos na tela.

## Já existiam na tela Empresas

Só um campo `ws_autorizacao`.

## O que faltava

Os 10 campos homologação/produção do contrato global, persistidos por `empresa_id`.

## Alterações

- `empresasConfiguracaoFiscal.js`: colunas `*_homologacao` / `*_producao`; GET devolve `urls_homologacao` e `urls_producao`; PUT parcial; troca de ambiente não apaga o outro bloco; fallback das 5 colunas legadas.
- `gestao-empresas-fiscal.js`: blocos URLS HOMOLOGAÇÃO e URLS PRODUÇÃO.
- Sem alteração de `emissor.js`, MUV, PDV Universal, VendaApplication.

`empresa_id` é o da rota `/api/empresas/:empresaId/configuracao-fiscal`.

## Testes

`tests/empresas/urls-fiscais-05-18-2.test.js` — 8 casos.

## Validação visual

Pendente.
