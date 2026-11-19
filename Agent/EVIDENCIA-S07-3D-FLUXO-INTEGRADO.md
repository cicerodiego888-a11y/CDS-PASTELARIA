# Evidência S07-3D — Fluxo integrado e observabilidade

## Fluxo HTTP real

```
POST /api/pedidos
  → rotas/pedidos.js (canal fixo EQUIPE no servidor)
  → EntradaPedidoService.receber
  → PedidoOperacionalService.criar (origemCanal)
  → CozinhaResolucaoDestinoService.resolverDestinoPedido
  → PedidoRepository.persistirResolucaoDestinoCozinha
```

Teste: `S07-3D — fluxo integrado POST /api/pedidos (real)` em  
`tests/cozinha/sprint07-s07-3d-resolucao-destino.test.js`

Comprovado (sem mock do serviço de resolução):

| Verificação | Resultado |
|-------------|-----------|
| `origem_canal` | `EQUIPE` (adaptador; body `IFOOD` ignorado) |
| `cozinha_canal_codigo` | `LOJA` |
| `unidade_cozinha_destino_id` | unidade configurada na S07-3C |
| `cozinha_resolucao_status` | `RESOLVIDO` |
| total / itens comerciais | preservados |
| `cozinha_rodadas` / `cozinha_itens` | sem incremento (sem despacho) |

## Observabilidade

Em `PedidoOperacionalService.criar`, catch da resolução:

- **não** cancela a criação comercial
- emite `console.warn(JSON.stringify({ evento: 'COZINHA_RESOLUCAO_DESTINO_FALHA', codigo, pedido_id, empresa_id, origem_canal, mensagem }))`
- sem dados pessoais (sem cliente/CPF)
- não grava destino inventado a partir da falha
- não despacha

Teste: `observabilidade: falha de resolução loga estruturado e não cancela pedido`
