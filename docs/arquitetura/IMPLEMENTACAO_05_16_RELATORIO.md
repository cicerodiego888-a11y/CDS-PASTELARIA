# Relatório — Sprint 05.16

## STATUS

Auditoria + correções P0 da gestão de empresas. **Sprint NÃO declarada 100% verde** — validação manual de clique não foi executada neste agente.

## CORRIGIDO

- Cache-bust `gestao-empresas-fiscal.js?v=0516` (quebra o lazy reuse do JS antigo)
- Status fiscal não derruba a lista
- GET fiscal falho ainda abre as 3 abas
- Após POST: resolve `id`/`empresa_id`, atualiza lista, **abre edição**
- `#gef-detalhe` existe em LOADING/ERROR
- `pintarShell` recoloca a edição se já houver empresa na sessão

## Tabela

| FUNCIONALIDADE | BACKEND | FRONTEND | ACESSÍVEL | TESTADA MANUALMENTE | STATUS |
|----------------|---------|----------|-----------|---------------------|--------|
| Menu Empresas (avançadas) | — | Sim | Sim | Não | CORRIGIDO |
| Listar empresas | GET /empresas | Sim | Sim | Não | OK |
| Nova empresa | POST | Sim | Sim | Não | OK |
| Abrir edição após criar | GET id + fiscal | Sim | Deve (após reload ERP) | Não | CORRIGIDO |
| Dados gerais | PUT /empresas/:id | Sim | Sim | Não | OK |
| Configuração fiscal | GET/PUT fiscal | Sim | Sim após edição | Não | CORRIGIDO |
| CSC (sem expor) | DTO 04.09 | Sim | Sim após edição | Não | OK |
| Certificado PFX | POST upload | Sim | Sim após edição | Não | CORRIGIDO |
| Sem /api/api | — | urlAbsoluta | Sim | Não | OK |
| PDV Universal menu | GET /pdv-universal/ | Sim | Sim | Não | OK |
| Contexto / 409 | GET contexto | Sim | Sim | Não | OK |
| Carrinho → comprovante | APIs 05.04–09 | bindUi | Código sim | Não | PENDENTE |

## VALIDAÇÃO MANUAL NÃO EXECUTADA

Ainda precisa clicar, após **fechar e reabrir o ERP** (ou Ctrl+F5 no ERP):

1. Configurações Avançadas → Empresas  
2. + NOVA EMPRESA com CNPJ **válido** (14 dígitos verificadores)  
3. SALVAR EMPRESA → deve aparecer topo + 3 botões de aba  
4. CONFIGURAÇÃO FISCAL → ambiente/série/CSC → salvar  
5. CERTIFICADO DIGITAL → PFX + senha  
6. Comercial → PDV Universal → contexto → busca → carrinho → FINALIZAR (se houver empresa e produto)

Sem esse clique, **não afirmar “validação visual concluída”**.
