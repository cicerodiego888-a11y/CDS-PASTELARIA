# Relatório — Sprint 05.17

## 1. Arquivo realmente carregado

`/erp/js/gestao-empresas-fiscal.js?v=` + `CDS_ERP_ASSET_VERSION` (`0517`, ou `window.CDS_ASSET_VERSION` se existir).

## 2. Causa do `/api/api`

`window.API_URL` = `origem/api`. Paths oficiais começavam com `/api/...`. Concatenação gerava `/api/api/empresas/...`.

## 3. Contrato do ID

`POST /api/empresas` devolve o DTO de `EmpresaService` com **`id`**. O frontend aceita também `empresa_id`, `empresaId` e `data.id` via `resolverEmpresaId`.

## 4. Edição após cadastro

`resolverEmpresaId(criada)` → atualiza lista → `abrirDetalhe(novaId)` → painel `data-gef-edicao="1"` com as três abas.

## 5. Configuração fiscal

`GET/PUT /api/empresas/:empresaId/configuracao-fiscal` (contrato 04.09). GET sem CSC/senha/path.

## 6. Certificado

`POST /api/fiscal/certificado/upload` com `empresa_id` da empresa aberta + PFX + senha só no envio.

## 7. PDV e empresa inválida

`carregarContextoComRecuperacao` remove `cds_empresa_id` e refaz GET. 401/403 → login. 409 `NENHUMA_EMPRESA_DISPONIVEL` → mensagem específica, não login.

## 8. Fluxos validados visualmente

Nenhum. **VALIDAÇÃO MANUAL NÃO EXECUTADA.**

## 9. O que ainda precisa clicar

ERP (recarregar a janela): Configurações Avançadas → Empresas → Nova empresa (CNPJ válido) → conferir 3 abas → fiscal → certificado. Comercial → PDV Universal → contexto.
