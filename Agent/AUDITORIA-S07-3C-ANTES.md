# Auditoria prévia — S07-3C (antes da implementação)

## Reutilizar

| Peça | Uso |
|------|-----|
| `isAdminOperacional` / `exigirRecurso('pedidos')` | Mesmo gate S07-2/3A/3B |
| `empresaIdDoReqPedido` + middleware empresa | Empresa do contexto |
| `cozinha_unidades` + FK composta `(id, empresa_id)` | Destino do canal |
| Padrão schema `verificar` / `exigir` / `garantir` (só teste) | Sem DDL nas APIs |
| `responderErro` + `exigirCozinhaOperacional` em `rotas/cozinha.js` | Contratos HTTP |
| UI `cozinha-roteamento.js` + nav/ACL | Evoluir listagem (não nova página) |
| APIs S07-3A `/roteamento*` | Permanecem; segmentos não removidos |

## Alterações necessárias

1. Tabelas `cozinha_canais` + `cozinha_canal_destinos` + migration S07-3C (não executar no oficial).
2. Serviço + rotas `/api/cozinha/canais*`.
3. Seed canal SISTEMA `LOJA` por empresa (idempotente).
4. UI: canais dinâmicos no lugar da tabela de segmentos fixos; modo/padrão 3A preservados.
5. Testes em DB temp com isolamento.

## Convivência S07-3A

- `cozinha_roteamento_segmentos` **permanece**.
- Canais são a evolução administrativa; segmentos antigos não são convertidos nem apagados nesta sprint.
- Transition plan: futuro mapa `segmento`→`canal.codigo` opcional; documentado no relatório final.
