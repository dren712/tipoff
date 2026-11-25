use anchor_lang::prelude::*;

pub const SEATS: usize = 6;
pub const SHOCKS: usize = 4;
pub const TAPE: usize = 24;
pub const NONE: u8 = 255;
pub const ROLE_TRADER: u8 = 1;
pub const ROLE_INSIDER: u8 = 2;

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle = 0,
    /// Waiting for the VRF callback.
    Pending = 1,
    /// Trading, then voting.
    Live = 2,
    Settled = 3,
}

/// A news shock: `bps` is added to the price `at` seconds into the round.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, PartialEq, Eq, Debug)]
pub struct Shock {
    pub at: u8,
    pub bps: i16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Seat {
    pub player: Pubkey,
    pub session: Pubkey,
    /// Lots held this round; negative is short.
    pub pos: i8,
    /// Chips paid and received this round; after settlement, the round's trading result.
    pub cash: i64,
    pub trades: u16,
    /// Score from the last settled round.
    pub last: i64,
    /// Score across rounds at this table.
    pub score: i64,
    pub rounds: u32,
}

impl Seat {
    pub fn signed_by(&self, key: &Pubkey) -> bool {
        self.player != Pubkey::default() && (*key == self.player || *key == self.session)
    }
}

/// One print on the public trade tape.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Print {
    pub seat: u8,
    pub delta: i8,
    pub price: i64,
    pub t: u16,
}

/// Public table state. Everything here is readable by anyone.
#[account]
#[derive(InitSpace)]
pub struct Table {
    pub authority: Pubkey,
    pub id: u64,
    pub bump: u8,
    pub phase: u8,
    pub round: u64,
    pub nonce: u64,
    pub requested_at: i64,
    pub t_start: i64,
    pub settled_at: i64,
    /// Oracle SOL/USD at the open, 8 decimals.
    pub open_price: i64,
    pub oracle_price: i64,
    /// Oracle price with every shock so far applied.
    pub price: i64,
    pub shock_bps: i32,
    pub shocks_seen: u8,
    /// Public entropy mixed in from every player who sits.
    pub entropy: [u8; 32],
    pub seats: [Seat; SEATS],
    pub tape: [Print; TAPE],
    pub tape_len: u32,
    // Unsealed at settlement; shocks appear here as they hit.
    pub insider: u8,
    pub caught: bool,
    pub votes: [u8; SEATS],
    pub shocks: [Shock; SHOCKS],
    pub revealed_salt: [u8; 32],
}

impl Table {
    pub fn push_tape(&mut self, p: Print) {
        self.tape[self.tape_len as usize % TAPE] = p;
        self.tape_len = self.tape_len.wrapping_add(1);
    }
}

/// Hidden for the whole round: private with no members.
#[account]
#[derive(InitSpace)]
pub struct Secret {
    pub table: Pubkey,
    pub bump: u8,
    pub round: u64,
    pub salt: [u8; 32],
    pub insider: u8,
    pub shocks: [Shock; SHOCKS],
}

/// Readable only by the player in this seat.
#[account]
#[derive(InitSpace)]
pub struct SeatPrivate {
    pub table: Pubkey,
    pub idx: u8,
    pub bump: u8,
    pub round: u64,
    pub role: u8,
    /// The round's shocks, filled only for the insider.
    pub shocks: [Shock; SHOCKS],
    pub vote: u8,
}

impl SeatPrivate {
    pub fn reset(&mut self) {
        self.round = 0;
        self.role = 0;
        self.shocks = [Shock::default(); SHOCKS];
        self.vote = NONE;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Player {
    pub wallet: Pubkey,
    pub session: Pubkey,
    pub bump: u8,
    pub score: i64,
    pub rounds: u32,
}

impl Player {
    pub fn signed_by(&self, key: &Pubkey) -> bool {
        *key == self.wallet || *key == self.session
    }
}

/// Lives on Solana and is never delegated; written by the checkpoint Magic Action.
#[account]
#[derive(InitSpace)]
pub struct Ledger {
    pub bump: u8,
    pub rounds: u64,
    pub last_round: u64,
    pub last_digest: [u8; 32],
}

pub const BOARD_LEN: usize = 50;
pub const BOARD_TABLES: usize = 8;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Entry {
    pub player: Pubkey,
    pub score: i64,
    pub rounds: u32,
    pub caught: u16,
    pub escapes: u16,
    pub streak: u16,
    pub best: u16,
}

/// Shared career board written on the rollup (`post_round`) and committed to Solana (`commit_board`).
#[account]
#[derive(InitSpace)]
pub struct Board {
    pub bump: u8,
    pub posted: [u64; BOARD_TABLES],
    pub entries: [Entry; BOARD_LEN],
}
