import { useWindowDimensions, View } from "react-native";
import { StoreListing } from "../utils/listings";
import ListingCard from "./ListingCard";

// Two-column masonry like the app home screen (three on wide desktops).
export default function ListingGrid({ listings }: { listings: StoreListing[] }) {
  const { width } = useWindowDimensions();
  const cols = width >= 900 ? 3 : 2;
  const columns: StoreListing[][] = Array.from({ length: cols }, () => []);
  listings.forEach((l, i) => columns[i % cols].push(l));

  return (
    <View style={{ flexDirection: "row", gap: 16 }}>
      {columns.map((col, i) => (
        <View key={i} style={{ flex: 1, gap: 16 }}>
          {col.map((l) => (
            <ListingCard key={l.id} listing={l} />
          ))}
        </View>
      ))}
    </View>
  );
}
