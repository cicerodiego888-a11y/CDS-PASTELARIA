# IMPLEMENTAÇÃO MBC-01

STATUS: CONCLUÍDA COM RESSALVAS (auditoria completa; fundação mínima; sem browser bancário — não há UI)

## Implementação

Fundação em `backend/motores/bancario/`. Sem rotas `/api/bancario`. Sem Open Finance. Sem tabelas novas. Sem alteração de financeiro, vendas, compras, caixa, TEF, PIX, MIS, MUC, PDV.

## Testes

MBC-01: 11/11 (`tests/bancario/motor-bancario-01.test.js`)

## Regressão (módulos auditados, sem alteração de testes antigos)

- financeiro 05.38.D: 20/20  
- ownership financeiro 05.41: 14/14  
- caixa 05.38.C: 17/17  
- ownership vendas 05.40: 13/13  
- compras isolamento financeiro 05.64: OK  

Nenhuma falha causada pela MBC-01.

## Arquivos

- `backend/motores/bancario/version.js`
- `backend/motores/bancario/index.js`
- `backend/motores/bancario/MotorBancarioService.js`
- `backend/motores/bancario/BancarioEmpresaContextoService.js`
- `backend/motores/bancario/contracts/constantes.js`
- `backend/motores/bancario/contracts/TransacaoBancariaNormalizada.js`
- `backend/motores/bancario/contracts/IBankProvider.js`
- `tests/bancario/motor-bancario-01.test.js`
- `docs/bancario/MBC-01-AUDITORIA-FUNDACAO.md`
- `docs/bancario/IMPLEMENTACAO_MBC_01_RELATORIO.md`

## Pendências

Persistência de contas (MBC-02). Secrets TEF/PIX em SQLite (pré-existente; não corrigido). `contas_pagar` sem tabela (pré-existente).

## Próxima sprint recomendada

**MBC-02 — Modelo de contas bancárias e instituições financeiras** (empresa_id explícito, sem credencial em claro, sem Open Finance).
