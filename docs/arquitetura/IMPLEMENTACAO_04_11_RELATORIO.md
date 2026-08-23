# Relatório — Sprint 04.11

## Status

Concluída (TEXT + HTML + HTTP opcional). Sem impressão física. 04.12 não iniciada.

## Arquitetura implementada

DTO 04.10 → `ComprovanteRenderer` → TEXT/HTML. Router obtém DTO e só então renderiza.

## Arquivos criados

- `backend/motores/muv/comprovante/ComprovanteRenderer.js`
- `ComprovanteTextoRenderer.js`
- `ComprovanteHtmlRenderer.js`
- `comprovanteLayout.js`
- `tests/muv/comprovante-renderizacao-04-11.test.js`
- docs 04.11

## Arquivos alterados

- `backend/rotas/atendimentos.js`
- `backend/motores/muv/index.js`
- `ARQUITETURA_MOTOR_UNIVERSAL_VENDAS_V1.md`

## Contrato TEXT / HTML

`renderizar(dto, { format: 'TEXT'|'HTML', largura, incluirDocumentosFiscais, incluirMensagemFinal })`  
Erros: `COMPROVANTE_FORMATO_INVALIDO`, `COMPROVANTE_DTO_INVALIDO`.

## Endpoint e compatibilidade

JSON default intacto. `formato`/`format` opcional.

## Segurança

Sem CSC/senha/PFX. HTML escapado. Rateio não renderizado.

## Testes novos

`comprovante-renderizacao-04-11` — **30/30**

## Regressão

04.01–04.10 + MUC, VendaApplication, orquestrador, TEF, dual-write 03.19, reservas 03.20, portas, MTS, pedido, compras, baixa, cancel/devolução — **OK**.

O scanner 04.01/04.09 passou a percorrer `.js` em subpastas (`comprovante/`).

## Falhas pré-existentes

`fiscal-platform` 26!==24 (fora do escopo), se ainda ocorrer.

## Limitações

Sem ESC/POS, PDF, QR gerado, UI, spooler.

## Próxima Sprint recomendada

Adaptador de impressão térmica/ESC/POS consumindo o TEXT desta sprint, ou preview HTML no PDV — sem nova fonte de dados.
