# Índice — Pacote de Auditoria Sprint 02 (Cozinha)

**Pasta absoluta:** `C:\projetos\CDS-SISTEMAS PASTELARIA\Agent\auditoria-sprint02-cozinha`

## Documentos

1. `RELATORIO-SPRINT02.md` — relatório executivo
2. `AUDITORIA-DESPACHO.md` — validações de negócio
3. `AUDITORIA-TRANSACAO-FIFO.md` — transação e FIFO
4. `AUDITORIA-IDEMPOTENCIA.md` — idempotência central
5. `AUDITORIA-SEGURANCA.md` — rotas e segurança
6. `AUDITORIA-BANCO.md` — schema / FKs / quantidades
7. `REGRESSAO-E-ESCOPO.md` — limites e módulos intocados
8. `RESULTADO-TESTES.md` — evidências de execução
9. `MANIFESTO.md` — inventário + SHA-256
10. `DIFF-SPRINT02.patch` — diff completo S02
11. `DIFF-server.js.patch` — diff isolado do mount

## Código (cópias)

- `codigo/CozinhaDespachoService.js`
- `codigo/cozinha.js`
- `codigo/cozinhaQuantidade.js`
- `codigo/cozinhaIdempotenciaHash.js`
- `codigo/cozinhaSchema.js`
- `codigo/empresaIdDoReqPedido.js`
- `codigo/server-mount-cozinha.excerpt.js`

## Testes e logs

- `testes/sprint02-despacho-fifo.test.js`
- `logs/sprint02-testes.log`
- `logs/sprint01-regressao.log`
- `logs/reproducoes-auditoria.log`
- `reproducoes/reproducoes-auditoria-sprint02.js`
- `reproducoes/RESULTADO-REPRODUCOES.json`

## Declarações

- Nenhum arquivo do projeto foi alterado **durante** a geração deste pacote (somente escrita sob `Agent/auditoria-sprint02-cozinha/`).
- Banco oficial não foi acessado.
- Sprint 03 não foi iniciada.
