import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import { useApp } from '../store.jsx';
import { Avatar, Empty } from '../ui.jsx';
import MemoryPanel from '../components/MemoryPanel.jsx';

export default function MemoryPage() {
  const { id } = useParams();
  const { characters } = useApp();
  const nav = useNavigate();
  const character = characters.find((c) => c.id === id);
  if (!character) return <div className="page-inner"><Empty title="Character not found" actions={<Link className="btn" to="/mine">My characters</Link>}>It may have been deleted.</Empty></div>;
  return (
    <div className="page">
      <div className="page-inner narrow">
        <div className="page-head">
          <button className="btn ghost icon" onClick={() => nav(-1)} aria-label="Back"><ArrowLeft size={18} /></button>
          <Avatar character={character} size={48} />
          <div className="grow">
            <h1 className="voice">{character.name}'s memory</h1>
            <p>{character.memoryCount} saved · {character.conversationCount} conversation{character.conversationCount === 1 ? '' : 's'}</p>
          </div>
          <Link className="btn" to={`/chat/${character.id}`}><MessageCircle size={16} aria-hidden="true" /> Chat</Link>
        </div>
        <MemoryPanel character={character} onOpenConversation={(cid) => nav(`/chat/${character.id}/${cid}`)} />
      </div>
    </div>
  );
}
